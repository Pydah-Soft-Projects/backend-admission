import mongoose from 'mongoose';

const leadSchema = new mongoose.Schema(
  {
    enquiryNumber: {
      type: String,
      unique: true,
      trim: true,
      index: true, // Index for faster searches
      sparse: true,
    },
    name: {
      type: String,
      required: [true, 'Name is required'],
      trim: true,
      index: true, // Index for faster searches
    },
    phone: {
      type: String,
      required: [true, 'Phone number is required'],
      trim: true,
      index: true, // Index for faster searches
    },
    email: {
      type: String,
      trim: true,
      lowercase: true,
      match: [/^\S+@\S+\.\S+$/, 'Please provide a valid email'],
      sparse: true, // Allow multiple nulls
    },
    fatherName: {
      type: String,
      required: [true, 'Father name is required'],
      trim: true,
    },
    motherName: {
      type: String,
      trim: true,
      default: '',
    },
    fatherPhone: {
      type: String,
      required: [true, 'Father phone number is required'],
      trim: true,
    },
    hallTicketNumber: {
      type: String,
      trim: true,
      index: true,
      default: '',
    },
    village: {
      type: String,
      required: [true, 'Village is required'],
      trim: true,
      index: true,
    },
    courseInterested: {
      type: String,
      trim: true,
    },
    district: {
      type: String,
      required: [true, 'District is required'],
      trim: true,
      index: true,
    },
    mandal: {
      type: String,
      required: [true, 'Mandal is required'],
      trim: true,
      index: true, // Index for faster filtering
    },
    state: {
      type: String,
      trim: true,
      default: '',
      index: true, // Index for faster filtering
    },
    isNRI: {
      type: Boolean,
      default: false,
      index: true,
    },
    gender: {
      type: String,
      trim: true,
      default: 'Not Specified',
      index: true,
    },
    rank: {
      type: Number,
      min: 0,
      index: true,
    },
    interCollege: {
      type: String,
      trim: true,
      default: '',
    },
    quota: {
      type: String,
      trim: true,
      index: true, // Index for faster filtering
      default: 'Not Applicable',
    },
    applicationStatus: {
      type: String,
      trim: true,
      default: 'Not Provided',
    },
    // Dynamic fields - stored as JSON for flexibility
    dynamicFields: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    // Lead tracking fields
    leadStatus: {
      type: String,
      default: 'New',
      index: true,
    },
    admissionNumber: {
      type: String,
      trim: true,
      unique: true,
      sparse: true,
    },
    assignedTo: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      index: true,
    },
    assignedAt: {
      type: Date,
      index: true,
    },
    assignedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    source: {
      type: String,
      trim: true,
    },
    // UTM Tracking Parameters
    utmSource: {
      type: String,
      trim: true,
      index: true,
    },
    utmMedium: {
      type: String,
      trim: true,
      index: true,
    },
    utmCampaign: {
      type: String,
      trim: true,
      index: true,
    },
    utmTerm: {
      type: String,
      trim: true,
    },
    utmContent: {
      type: String,
      trim: true,
    },
    statusLogs: [
      {
        status: { type: String },
        comment: { type: String },
        changedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        changedAt: { type: Date, default: Date.now },
      },
    ],
    // Activity tracking
    lastFollowUp: {
      type: Date,
    },
    notes: {
      type: String,
      trim: true,
    },
    // Upload tracking
    uploadedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    uploadBatchId: {
      type: String,
      index: true, // Index for tracking upload batches
    },
  },
  {
    timestamps: true,
  }
);

// Compound indexes for common queries
leadSchema.index({ district: 1, mandal: 1 });
leadSchema.index({ mandal: 1, state: 1 });
leadSchema.index({ leadStatus: 1, assignedTo: 1 });
leadSchema.index({ hallTicketNumber: 1 });
leadSchema.index({ createdAt: -1 }); // For sorting by newest
leadSchema.index({ phone: 1, name: 1 }); // For duplicate detection

// Text index for searching across multiple fields
leadSchema.index({
  enquiryNumber: 'text',
  name: 'text',
  phone: 'text',
  email: 'text',
  fatherName: 'text',
  motherName: 'text',
  courseInterested: 'text',
  district: 'text',
  mandal: 'text',
  state: 'text',
  applicationStatus: 'text',
  hallTicketNumber: 'text',
  interCollege: 'text',
});

// Index for enquiry number search
leadSchema.index({ enquiryNumber: 1 });

const Lead = mongoose.model('Lead', leadSchema);

export default Lead;

