
import 'dotenv/config';
import express from 'express';
import mongoose from 'mongoose';
import nodemailer from 'nodemailer';
import helmet from 'helmet';
import cors from 'cors';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';

const app = express();

app.disable('x-powered-by');
app.set('trust proxy', 1);

// Security middleware
app.use(helmet());

app.use(cors({
  origin: process.env.CLIENT_ORIGIN || 'http://localhost:5173',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type']
}));

app.use(express.json({ limit: '20kb' }));

// MongoDB connection reuse for Vercel
let cachedConnection = null;
let connectionPromise = null;

async function connectDB() {
  if (mongoose.connection.readyState === 1) {
    return mongoose.connection;
  }

  if (!process.env.MONGODB_URI) {
    throw new Error('MONGODB_URI is missing');
  }

  if (!connectionPromise) {
    connectionPromise = mongoose.connect(
      process.env.MONGODB_URI,
      {
        serverSelectionTimeoutMS: 5000,
        maxPoolSize: 5
      }
    ).then(() => {
      console.log('MongoDB connected');
      cachedConnection = mongoose.connection;
      return cachedConnection;
    }).catch((error) => {
      connectionPromise = null;
      throw error;
    });
  }

  return connectionPromise;
}

// Validation schema
const contactSchema = z.object({
  name: z.string().trim().min(2).max(100),
  email: z.email().max(254),
  phone: z.string().trim().min(7).max(30),
  service: z.string().trim().min(2).max(100),
  type: z.string().max(100).optional().default(''),
  business: z.string().max(150).optional().default(''),
  website: z.string().max(300).optional().default(''),
  description: z.string().trim().min(10).max(5000),
  budget: z.string().max(100).optional().default(''),
  timeline: z.string().max(100).optional().default(''),
  contact: z.string().max(100).optional().default('')
});

// MongoDB enquiry model
const enquirySchema = new mongoose.Schema({
  name: String,
  email: String,
  phone: String,
  service: String,
  type: String,
  business: String,
  website: String,
  description: String,
  budget: String,
  timeline: String,
  contact: String,
  emailSent: {
    type: Boolean,
    default: false
  }
}, { timestamps: true });

const Enquiry = mongoose.models.Enquiry ||
  mongoose.model('Enquiry', enquirySchema);

// Health check
app.get('/api/health', (_req, res) => {
  res.status(200).json({
    success: true,
    message: 'GrowSaathi API is running'
  });
});

// Contact rate limiting
const contactLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: {
    message: 'Too many requests. Please try again later.'
  }
});

// Contact form endpoint
app.post('/api/contact', contactLimiter, async (req, res) => {
  const parsed = contactSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({
      message: 'Please check your project brief.',
      issues: parsed.error.issues.map(
        issue => issue.path.join('.')
      )
    });
  }

  try {
    await connectDB();

    const record = await Enquiry.create(parsed.data);

    // Email notification
    if (
      process.env.SMTP_HOST &&
      process.env.SMTP_USER &&
      process.env.SMTP_PASS &&
      process.env.MAIL_TO
    ) {
      try {
        const smtpPort = Number(process.env.SMTP_PORT || 465);

        const transporter = nodemailer.createTransport({
          host: process.env.SMTP_HOST,
          port: smtpPort,
          secure: smtpPort === 465,
          auth: {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASS
          },
          connectionTimeout: 5000,
          socketTimeout: 8000
        });

        await transporter.sendMail({
          from: process.env.SMTP_USER,
          to: process.env.MAIL_TO,
          replyTo: parsed.data.email,
          subject: `GrowSaathi Project Enquiry: ${parsed.data.service}`,
          text: Object.entries(parsed.data)
            .map(([key, value]) => `${key}: ${value}`)
            .join('\n')
        });

        record.emailSent = true;
        await record.save();
      } catch (error) {
        console.error('Email failed:', error.message);
      }
    }

    return res.status(201).json({
      success: true,
      message: 'Project brief received successfully.',
      id: record.id
    });

  } catch (error) {
    console.error('Contact API error:', error.message);

    return res.status(503).json({
      success: false,
      message: 'Unable to save enquiry. Please try again.'
    });
  }
});

// Unknown API routes
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: 'API endpoint not found'
  });
});

// Local development only
if (!process.env.VERCEL) {
  const PORT = Number(process.env.PORT || 5000);

  connectDB()
    .then(() => {
      app.listen(PORT, () => {
        console.log(`GrowSaathi API running on port ${PORT}`);
      });
    })
    .catch((error) => {
      console.error('Startup failed:', error.message);
      process.exitCode = 1;
    });
}

// Export Express app for Vercel
export default app;
