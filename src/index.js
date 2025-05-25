const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const { createClient } = require('redis');
const { promisify } = require('util');

const app = express();
const port = process.env.PORT || 3000;

// Redis client setup
const redisClient = createClient({
  url: process.env.REDIS_URL || 'redis://redis:6379'
});

redisClient.on('error', (err) => console.error('Redis Client Error', err));
redisClient.connect();

// Multer configuration
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, 'uploads');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${file.originalname}`);
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB limit
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['video/mp4', 'video/quicktime', 'video/x-msvideo', 'video/x-matroska'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only video files are allowed.'), false);
    }
  }
});

// Middleware
app.use(cors());
app.use(express.json());

// Upload endpoint
app.post('/upload/video', upload.single('video'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    // Store file metadata in Redis
    const fileKey = `video:${req.file.filename}`;
    await redisClient.set(fileKey, JSON.stringify({
      path: req.file.path,
      size: req.file.size,
      mimetype: req.file.mimetype
    }));
    await redisClient.expire(fileKey, 60); // 60 seconds TTL

    res.status(204).send();
  } catch (error) {
    console.error('Upload error:', error);
    res.status(400).json({ error: error.message });
  }
});

// Streaming endpoint
app.get('/static/video/:filename', async (req, res) => {
  try {
    const filename = req.params.filename;
    const fileKey = `video:${filename}`;
    
    // Check Redis cache first
    const cachedData = await redisClient.get(fileKey);
    if (!cachedData) {
      return res.status(404).json({ error: 'File not found' });
    }

    const fileData = JSON.parse(cachedData);
    const filePath = fileData.path;

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'File not found' });
    }

    const stat = fs.statSync(filePath);
    const fileSize = stat.size;
    const range = req.headers.range;

    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunksize = (end - start) + 1;
      const file = fs.createReadStream(filePath, { start, end });
      
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunksize,
        'Content-Type': fileData.mimetype
      });
      
      file.pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Length': fileSize,
        'Content-Type': fileData.mimetype
      });
      
      fs.createReadStream(filePath).pipe(res);
    }
  } catch (error) {
    console.error('Streaming error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'File size exceeds 10MB limit' });
    }
    return res.status(400).json({ error: err.message });
  }
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
}); 