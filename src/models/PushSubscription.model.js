import mongoose from 'mongoose';

const pushSubscriptionSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'User ID is required'],
      index: true,
    },
    endpoint: {
      type: String,
      required: [true, 'Endpoint is required'],
      unique: true,
      index: true,
    },
    keys: {
      p256dh: {
        type: String,
        required: [true, 'P256DH key is required'],
      },
      auth: {
        type: String,
        required: [true, 'Auth key is required'],
      },
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    deactivatedAt: {
      type: Date,
    },
    deactivationReason: {
      type: String,
    },
    userAgent: {
      type: String,
    },
    createdAt: {
      type: Date,
      default: Date.now,
    },
    updatedAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
  }
);

// Compound index for efficient queries
pushSubscriptionSchema.index({ userId: 1, isActive: 1 });

const PushSubscription = mongoose.model('PushSubscription', pushSubscriptionSchema);

export default PushSubscription;

