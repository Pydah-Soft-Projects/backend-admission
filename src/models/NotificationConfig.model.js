import mongoose from 'mongoose';

const notificationConfigSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      required: [true, 'Config type is required'],
      unique: true,
      enum: ['email_channel', 'sms_channel', 'push_enabled'],
      index: true,
    },
    value: {
      type: String,
      required: [true, 'Config value is required'],
    },
    description: {
      type: String,
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
  },
  {
    timestamps: true,
  }
);

// Ensure only one config per type
notificationConfigSchema.index({ type: 1 }, { unique: true });

const NotificationConfig = mongoose.model('NotificationConfig', notificationConfigSchema);

export default NotificationConfig;

