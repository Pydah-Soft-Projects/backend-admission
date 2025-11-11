import mongoose from 'mongoose';

const variableEntrySchema = new mongoose.Schema(
  {
    key: { type: String, required: true, trim: true },
    value: { type: String, trim: true },
  },
  { _id: false }
);

const communicationSchema = new mongoose.Schema(
  {
    leadId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Lead',
      required: true,
      index: true,
    },
    contactNumber: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    type: {
      type: String,
      enum: ['call', 'sms'],
      required: true,
      index: true,
    },
    direction: {
      type: String,
      enum: ['outgoing', 'incoming'],
      default: 'outgoing',
    },
    status: {
      type: String,
      enum: ['pending', 'success', 'failed'],
      default: 'success',
      index: true,
    },
    remarks: {
      type: String,
      trim: true,
    },
    callOutcome: {
      type: String,
      trim: true,
    },
    durationSeconds: {
      type: Number,
      min: 0,
    },
    template: {
      templateId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'MessageTemplate',
      },
      dltTemplateId: {
        type: String,
        trim: true,
      },
      name: {
        type: String,
        trim: true,
      },
      language: {
        type: String,
        trim: true,
        lowercase: true,
      },
      originalContent: {
        type: String,
        trim: true,
      },
      renderedContent: {
        type: String,
        trim: true,
      },
      variables: {
        type: [variableEntrySchema],
        default: [],
      },
    },
    providerMessageIds: {
      type: [String],
      default: [],
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
    },
    sentBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    sentAt: {
      type: Date,
      default: Date.now,
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

communicationSchema.index({ leadId: 1, sentAt: -1 });
communicationSchema.index({ leadId: 1, contactNumber: 1, type: 1 });

const Communication = mongoose.model('Communication', communicationSchema);

export default Communication;

