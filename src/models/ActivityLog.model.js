import mongoose from 'mongoose';

const activityLogSchema = new mongoose.Schema(
  {
    leadId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Lead',
      required: true,
      index: true, // Index for fast queries
    },
    type: {
      type: String,
      enum: ['status_change', 'comment', 'follow_up', 'quota_change', 'joining_update'],
      required: true,
      index: true,
    },
    oldStatus: {
      type: String,
      default: null,
    },
    newStatus: {
      type: String,
      default: null,
    },
    comment: {
      type: String,
      default: null,
    },
    performedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    metadata: {
      type: Map,
      of: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  {
    timestamps: true, // createdAt, updatedAt
  }
);

// Compound index for fast queries by leadId and createdAt
activityLogSchema.index({ leadId: 1, createdAt: -1 });

// Index for querying by type
activityLogSchema.index({ type: 1, createdAt: -1 });

const ActivityLog = mongoose.model('ActivityLog', activityLogSchema);

export default ActivityLog;

