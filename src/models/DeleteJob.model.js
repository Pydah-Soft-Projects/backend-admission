import mongoose from 'mongoose';

const DeleteJobSchema = new mongoose.Schema(
  {
    jobId: {
      type: String,
      unique: true,
      required: true,
      index: true,
    },
    leadIds: [{
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Lead',
    }],
    status: {
      type: String,
      enum: ['queued', 'processing', 'completed', 'failed'],
      default: 'queued',
      index: true,
    },
    deletedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    stats: {
      requestedCount: Number,
      validCount: Number,
      deletedLeadCount: Number,
      deletedLogCount: Number,
      durationMs: Number,
    },
    errorDetails: [{
      leadId: mongoose.Schema.Types.ObjectId,
      error: String,
    }],
    message: String,
    startedAt: Date,
    completedAt: Date,
  },
  {
    timestamps: true,
  }
);

const DeleteJob = mongoose.model('DeleteJob', DeleteJobSchema);

export default DeleteJob;

