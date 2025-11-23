import mongoose from 'mongoose';

const shortUrlSchema = new mongoose.Schema(
  {
    shortCode: {
      type: String,
      unique: true,
      sparse: true, // Allow null values (for long URLs without short code)
      index: true,
      trim: true,
    },
    originalUrl: {
      type: String,
      required: [true, 'Original URL is required'],
    },
    // UTM Parameters
    utmSource: {
      type: String,
      trim: true,
    },
    utmMedium: {
      type: String,
      trim: true,
    },
    utmCampaign: {
      type: String,
      trim: true,
    },
    utmTerm: {
      type: String,
      trim: true,
    },
    utmContent: {
      type: String,
      trim: true,
    },
    // Tracking
    clickCount: {
      type: Number,
      default: 0,
    },
    clicks: [
      {
        clickedAt: {
          type: Date,
          default: Date.now,
        },
        ipAddress: {
          type: String,
        },
        userAgent: {
          type: String,
        },
        referer: {
          type: String,
        },
      },
    ],
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    expiresAt: {
      type: Date,
    },
  },
  {
    timestamps: true,
  }
);

// Index for efficient lookups
shortUrlSchema.index({ shortCode: 1, isActive: 1 });

const ShortUrl = mongoose.model('ShortUrl', shortUrlSchema);

export default ShortUrl;

