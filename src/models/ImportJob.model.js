import mongoose from 'mongoose';

const ImportJobSchema = new mongoose.Schema(
  {
    uploadId: {
      type: String,
      unique: true,
      required: true,
      index: true,
    },
    originalName: String,
    filePath: {
      type: String,
      required: true,
    },
    fileSize: Number,
    extension: String,
    selectedSheets: [String],
    sourceLabel: String,
    status: {
      type: String,
      enum: ['queued', 'processing', 'completed', 'failed'],
      default: 'queued',
      index: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    uploadBatchId: {
      type: String,
      index: true,
    },
    stats: {
      totalProcessed: Number,
      totalSuccess: Number,
      totalErrors: Number,
      sheetsProcessed: [String],
      durationMs: Number,
    },
    errorDetails: [
      {
        sheet: String,
        row: Number,
        error: String,
      },
    ],
    message: String,
    startedAt: Date,
    completedAt: Date,
    uploadToken: String,
  },
  {
    timestamps: true,
  }
);

const ImportJob = mongoose.model('ImportJob', ImportJobSchema);

export default ImportJob;

