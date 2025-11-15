import mongoose from 'mongoose';
import {
  encryptSensitiveValue,
  decryptSensitiveValue,
} from '../utils/encryption.util.js';

const { Schema } = mongoose;

const createEncryptedStringField = (options = {}) => ({
  type: String,
  set: encryptSensitiveValue,
  get: decryptSensitiveValue,
  default: '',
  ...options,
});

const documentStatusValues = ['pending', 'received'];

const admissionSchema = new Schema(
  {
    leadId: {
      type: Schema.Types.ObjectId,
      ref: 'Lead',
      required: true,
      unique: true,
      index: true,
    },
    enquiryNumber: {
      type: String,
      trim: true,
      index: true,
    },
    // Store complete lead data snapshot (not populated)
    leadData: {
      type: Schema.Types.Mixed,
      default: {},
    },
    paymentSummary: {
      totalFee: { type: Number, min: 0, default: 0 },
      totalPaid: { type: Number, min: 0, default: 0 },
      balance: { type: Number, min: 0, default: 0 },
      currency: { type: String, default: 'INR', uppercase: true },
      status: {
        type: String,
        enum: ['not_started', 'partial', 'paid'],
        default: 'not_started',
      },
      lastPaymentAt: { type: Date },
    },
    joiningId: {
      type: Schema.Types.ObjectId,
      ref: 'Joining',
      required: true,
      unique: true,
    },
    admissionNumber: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    status: {
      type: String,
      enum: ['active', 'withdrawn'],
      default: 'active',
      index: true,
    },
    admissionDate: {
      type: Date,
      default: Date.now,
    },
    courseInfo: {
      courseId: { type: Schema.Types.ObjectId, ref: 'Course', index: true },
      branchId: { type: Schema.Types.ObjectId, ref: 'Branch', index: true },
      course: { type: String, trim: true, default: '' },
      branch: { type: String, trim: true, default: '' },
      quota: { type: String, trim: true, default: '' },
    },
    studentInfo: {
      name: { type: String, trim: true, required: true },
      aadhaarNumber: createEncryptedStringField(),
      phone: { type: String, trim: true, default: '' },
      gender: { type: String, trim: true, default: '' },
      dateOfBirth: { type: String, trim: true, default: '' },
      notes: { type: String, trim: true, default: '' },
    },
    parents: {
      father: {
        name: { type: String, trim: true, default: '' },
        phone: { type: String, trim: true, default: '' },
        aadhaarNumber: createEncryptedStringField(),
      },
      mother: {
        name: { type: String, trim: true, default: '' },
        phone: { type: String, trim: true, default: '' },
        aadhaarNumber: createEncryptedStringField(),
      },
    },
    reservation: {
      general: {
        type: String,
        enum: ['oc', 'ews', 'bc-a', 'bc-b', 'bc-c', 'bc-d', 'bc-e', 'sc', 'st'],
        required: true,
      },
      other: [{ type: String, trim: true }],
    },
    address: {
      communication: {
        doorOrStreet: { type: String, trim: true, default: '' },
        landmark: { type: String, trim: true, default: '' },
        villageOrCity: { type: String, trim: true, default: '' },
        mandal: { type: String, trim: true, default: '' },
        district: { type: String, trim: true, default: '' },
        pinCode: { type: String, trim: true, default: '' },
      },
      relatives: [
        new Schema(
          {
            name: { type: String, trim: true, default: '' },
            relationship: { type: String, trim: true, default: '' },
            doorOrStreet: { type: String, trim: true, default: '' },
            landmark: { type: String, trim: true, default: '' },
            villageOrCity: { type: String, trim: true, default: '' },
            mandal: { type: String, trim: true, default: '' },
            district: { type: String, trim: true, default: '' },
            pinCode: { type: String, trim: true, default: '' },
          },
          { _id: false }
        ),
      ],
    },
    qualifications: {
      ssc: { type: Boolean, default: false },
      interOrDiploma: { type: Boolean, default: false },
      ug: { type: Boolean, default: false },
      mediums: {
        type: [String],
        enum: ['english', 'telugu', 'other'],
        default: [],
      },
      otherMediumLabel: { type: String, trim: true, default: '' },
    },
    educationHistory: [
      new Schema(
        {
          level: {
            type: String,
            enum: ['ssc', 'inter_diploma', 'ug', 'other'],
            required: true,
          },
          otherLevelLabel: { type: String, trim: true, default: '' },
          courseOrBranch: { type: String, trim: true, default: '' },
          yearOfPassing: { type: String, trim: true, default: '' },
          institutionName: { type: String, trim: true, default: '' },
          institutionAddress: { type: String, trim: true, default: '' },
          hallTicketNumber: { type: String, trim: true, default: '' },
          totalMarksOrGrade: { type: String, trim: true, default: '' },
          cetRank: { type: String, trim: true, default: '' },
        },
        { _id: false }
      ),
    ],
    siblings: [
      new Schema(
        {
          name: { type: String, trim: true, default: '' },
          relation: { type: String, trim: true, default: '' },
          studyingStandard: { type: String, trim: true, default: '' },
          institutionName: { type: String, trim: true, default: '' },
        },
        { _id: false }
      ),
    ],
    documents: {
      ssc: { type: String, enum: documentStatusValues, default: 'pending' },
      inter: { type: String, enum: documentStatusValues, default: 'pending' },
      ugOrPgCmm: { type: String, enum: documentStatusValues, default: 'pending' },
      transferCertificate: {
        type: String,
        enum: documentStatusValues,
        default: 'pending',
      },
      studyCertificate: {
        type: String,
        enum: documentStatusValues,
        default: 'pending',
      },
      aadhaarCard: {
        type: String,
        enum: documentStatusValues,
        default: 'pending',
      },
      photos: { type: String, enum: documentStatusValues, default: 'pending' },
      incomeCertificate: {
        type: String,
        enum: documentStatusValues,
        default: 'pending',
      },
      casteCertificate: {
        type: String,
        enum: documentStatusValues,
        default: 'pending',
      },
      cetRankCard: {
        type: String,
        enum: documentStatusValues,
        default: 'pending',
      },
      cetHallTicket: {
        type: String,
        enum: documentStatusValues,
        default: 'pending',
      },
      allotmentLetter: {
        type: String,
        enum: documentStatusValues,
        default: 'pending',
      },
      joiningReport: {
        type: String,
        enum: documentStatusValues,
        default: 'pending',
      },
      bankPassBook: {
        type: String,
        enum: documentStatusValues,
        default: 'pending',
      },
      rationCard: {
        type: String,
        enum: documentStatusValues,
        default: 'pending',
      },
    },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  {
    timestamps: true,
    toJSON: { getters: true },
    toObject: { getters: true },
  }
);

admissionSchema.index({ admissionNumber: 1 });
admissionSchema.index({ leadId: 1, admissionNumber: 1 });

const Admission = mongoose.model('Admission', admissionSchema);

export default Admission;


