import mongoose from 'mongoose';

const variableSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, trim: true },
    label: { type: String, trim: true },
    defaultValue: { type: String, trim: true },
  },
  { _id: false }
);

const messageTemplateSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    dltTemplateId: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    language: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      default: 'en',
    },
    content: {
      type: String,
      required: true,
      trim: true,
    },
    description: {
      type: String,
      trim: true,
    },
    isUnicode: {
      type: Boolean,
      default: false,
    },
    variables: {
      type: [variableSchema],
      default: [],
    },
    variableCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
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

messageTemplateSchema.index({ language: 1, isActive: 1 });
messageTemplateSchema.index({ name: 1, language: 1 }, { unique: false });

const MessageTemplate = mongoose.model('MessageTemplate', messageTemplateSchema);

export default MessageTemplate;

