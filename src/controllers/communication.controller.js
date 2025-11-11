import mongoose from 'mongoose';
import Communication from '../models/Communication.model.js';
import MessageTemplate from '../models/MessageTemplate.model.js';
import Lead from '../models/Lead.model.js';
import ActivityLog from '../models/ActivityLog.model.js';
import { successResponse, errorResponse } from '../utils/response.util.js';
import { sendSmsThroughBulkSmsApps } from '../services/bulkSms.service.js';

const { ObjectId } = mongoose.Types;

const sanitizeNumber = (number) => String(number || '').replace(/[^\d+]/g, '');

const collectLeadContactNumbers = (lead) => {
  const numbers = new Set();

  if (!lead) {
    return numbers;
  }

  [lead.phone, lead.fatherPhone].forEach((num) => {
    const sanitized = sanitizeNumber(num);
    if (sanitized) {
      numbers.add(sanitized);
    }
  });

  if (lead.dynamicFields && typeof lead.dynamicFields === 'object') {
    Object.values(lead.dynamicFields).forEach((value) => {
      if (typeof value === 'string' || typeof value === 'number') {
        const sanitized = sanitizeNumber(value);
        if (sanitized.length >= 10) {
          numbers.add(sanitized);
        }
      }
    });
  }

  return numbers;
};

const findTemplate = async (templateId) => {
  if (!templateId) {
    throw new Error('Template ID is required');
  }

  const template = await MessageTemplate.findOne({
    _id: templateId,
    isActive: true,
  }).lean();

  if (!template) {
    throw new Error('Template not found or inactive');
  }

  return template;
};

const renderTemplateContent = (template, variables = []) => {
  const placeholders = template.variableCount || 0;

  const variablesByKey = new Map();

  variables.forEach((variable, index) => {
    if (!variable) return;
    const templateVar = template.variables?.[index];
    const key =
      variable.key?.trim() ||
      templateVar?.key ||
      `var${index + 1}`;
    if (!key) return;
    const value =
      variable.value !== undefined && variable.value !== null
        ? String(variable.value)
        : variable.defaultValue !== undefined && variable.defaultValue !== null
        ? String(variable.defaultValue)
        : undefined;
    if (value !== undefined) {
      variablesByKey.set(key, value);
    }
  });

  const normalizedValues = Array.from({ length: placeholders }).map((_, index) => {
    const templateVar = template.variables?.[index];
    const key = templateVar?.key || `var${index + 1}`;

    if (variablesByKey.has(key)) {
      return variablesByKey.get(key);
    }

    if (variables[index]?.value !== undefined && variables[index]?.value !== null) {
      return String(variables[index].value);
    }

    if (templateVar?.defaultValue) {
      return templateVar.defaultValue;
    }

    return '';
  });

  let placeholderIndex = 0;
  const rendered = template.content.replace(/\{#var#\}/gi, () => {
    const value = normalizedValues[placeholderIndex] ?? '';
    placeholderIndex += 1;
    return value;
  });

  const mappedVariables =
    template.variables?.map((variable, index) => ({
      key: variable.key || `var${index + 1}`,
      label: variable.label || `Variable ${index + 1}`,
      defaultValue: variable.defaultValue || '',
      value: normalizedValues[index] ?? '',
    })) || [];

  return {
    rendered,
    mappedVariables,
  };
};

const ensureLeadAndNumbers = async (leadId, contactNumbers = []) => {
  if (!ObjectId.isValid(leadId)) {
    throw new Error('Invalid lead ID');
  }

  const lead = await Lead.findById(leadId).lean();

  if (!lead) {
    throw new Error('Lead not found');
  }

  const knownNumbers = collectLeadContactNumbers(lead);

  const validatedNumbers = (Array.isArray(contactNumbers) ? contactNumbers : [contactNumbers])
    .map(sanitizeNumber)
    .filter(Boolean);

  if (validatedNumbers.length === 0) {
    throw new Error('At least one valid contact number is required');
  }

  const invalidNumbers = validatedNumbers.filter((num) => !knownNumbers.has(num));

  if (invalidNumbers.length > 0) {
    throw new Error(
      `Number(s) ${invalidNumbers.join(', ')} are not associated with this lead.`
    );
  }

  return {
    lead,
    validatedNumbers,
  };
};

export const logCallCommunication = async (req, res) => {
  try {
    const { leadId } = req.params;
    const { contactNumber, remarks, outcome, durationSeconds } = req.body;

    const { lead, validatedNumbers } = await ensureLeadAndNumbers(leadId, [contactNumber]);

    const sanitizedNumber = validatedNumbers[0];

    const communication = await Communication.create({
      leadId: lead._id,
      contactNumber: sanitizedNumber,
      type: 'call',
      direction: 'outgoing',
      remarks: remarks?.trim(),
      callOutcome: outcome?.trim(),
      durationSeconds: durationSeconds ? Number(durationSeconds) : undefined,
      sentBy: req.user._id,
      sentAt: new Date(),
      status: 'success',
      metadata: {
        source: 'click_to_call',
      },
    });

    await Lead.findByIdAndUpdate(lead._id, { lastFollowUp: new Date() });

    const commentParts = [`Call logged for ${sanitizedNumber}`];
    if (outcome?.trim()) {
      commentParts.push(`Outcome: ${outcome.trim()}`);
    }
    if (remarks?.trim()) {
      commentParts.push(`Remarks: ${remarks.trim()}`);
    }

    await ActivityLog.create({
      leadId: lead._id,
      type: 'comment',
      comment: commentParts.join(' | ') || `Call logged for ${sanitizedNumber}`,
      performedBy: req.user._id,
      metadata: {
        communicationId: communication._id,
        communicationType: 'call',
        contactNumber: sanitizedNumber,
        callOutcome: outcome?.trim() || null,
        durationSeconds: durationSeconds ? Number(durationSeconds) : null,
      },
    });

    return successResponse(res, communication, 'Call logged successfully', 201);
  } catch (error) {
    console.error('Error logging call communication:', error);
    return errorResponse(res, error.message || 'Failed to log call', 500);
  }
};

export const sendSmsCommunication = async (req, res) => {
  try {
    const { leadId } = req.params;
    const { templates, contactNumbers } = req.body;

    if (!Array.isArray(templates) || templates.length === 0) {
      return errorResponse(res, 'At least one template is required', 400);
    }

    const { lead, validatedNumbers } = await ensureLeadAndNumbers(leadId, contactNumbers);

    const results = [];
    const communicationPayloads = [];
    const templateCommunicationMeta = [];

    for (const entry of templates) {
      const templateId = entry?.templateId || entry?._id;
      const userVariables = Array.isArray(entry?.variables) ? entry.variables : [];

      let template;
      try {
        template = await findTemplate(templateId);
      } catch (templateError) {
        results.push({
          templateId,
          success: false,
          error: templateError.message,
        });
        continue;
      }

      const { rendered, mappedVariables } = renderTemplateContent(template, userVariables);

      let apiResponse;
      let status = 'success';
      let errorMessage = null;

      const messagePreview = rendered.slice(0, 500);
      const unresolvedPlaceholders = /\{#var#\}/i.test(rendered);

      console.info('[Communications][SMS] Prepared payload', {
        leadId: lead._id.toString(),
        templateId: template._id.toString(),
        templateName: template.name,
        language: template.language,
        recipientCount: validatedNumbers.length,
        numbersPreview: validatedNumbers.slice(0, 5),
        variables: mappedVariables.map((variable) => ({
          key: variable.key,
          value: variable.value,
        })),
        messagePreview,
        hasUnresolvedPlaceholders: unresolvedPlaceholders,
      });

      if (unresolvedPlaceholders) {
        console.warn('[Communications][SMS] Template contains unresolved placeholders', {
          templateId: template._id.toString(),
          templateName: template.name,
          messagePreview,
        });
      }

      try {
        apiResponse = await sendSmsThroughBulkSmsApps({
          numbers: validatedNumbers,
          message: rendered,
          isUnicode: template.isUnicode || template.language !== 'en',
        });
        status = apiResponse.success ? 'success' : 'failed';
        const primaryMessageId = Array.isArray(apiResponse.messageIds)
          ? apiResponse.messageIds[0]
          : undefined;
        console.info('[Communications][SMS] Provider response', {
          templateId: template._id.toString(),
          success: apiResponse.success,
          messageId: primaryMessageId,
          transport: apiResponse.transport,
          durationMs: apiResponse.durationMs,
          responseSnippet: apiResponse.responseText?.slice(0, 500),
        });
      } catch (providerError) {
        status = 'failed';
        errorMessage = providerError.message;
        apiResponse = {
          success: false,
          messageIds: [],
          responseText: providerError.response?.data || providerError.message,
          numbers: validatedNumbers,
          durationMs: 0,
        };
        console.error('[Communications][SMS] Provider error', {
          templateId: template._id.toString(),
          error: providerError?.message,
          responseText:
            providerError?.response?.data && typeof providerError.response.data === 'string'
              ? providerError.response.data.slice(0, 500)
              : providerError?.response?.data,
        });
      }

      const createdAt = new Date();

      const startIndex = communicationPayloads.length;

      for (const number of validatedNumbers) {
        communicationPayloads.push({
          leadId: lead._id,
          contactNumber: number,
          type: 'sms',
          direction: 'outgoing',
          status,
          sentBy: req.user._id,
          sentAt: createdAt,
          template: {
            templateId: template._id,
            dltTemplateId: template.dltTemplateId,
            name: template.name,
            language: template.language,
            originalContent: template.content,
            renderedContent: rendered,
            variables: mappedVariables,
          },
          providerMessageIds:
            Array.isArray(apiResponse?.messageIds) && apiResponse.messageIds.length > 0
              ? [apiResponse.messageIds[0]]
              : [],
          metadata: {
            apiResponseText: apiResponse?.responseText,
            durationMs: apiResponse?.durationMs,
            error: errorMessage,
          },
        });
      }

      templateCommunicationMeta.push({
        template,
        status,
        errorMessage,
        apiResponse,
        numbers: validatedNumbers,
        startIndex,
        endIndex: communicationPayloads.length,
        createdAt,
      });

        results.push({
        templateId: template._id,
        templateName: template.name,
        success: status === 'success',
          messageId:
            Array.isArray(apiResponse?.messageIds) && apiResponse.messageIds.length > 0
              ? apiResponse.messageIds[0]
              : undefined,
        responseText: apiResponse?.responseText,
        error: errorMessage,
      });
    }

    let savedCommunications = [];

    if (communicationPayloads.length > 0) {
      savedCommunications = await Communication.insertMany(communicationPayloads, {
        ordered: false,
      });

      await Lead.findByIdAndUpdate(lead._id, {
        lastFollowUp: new Date(),
      });

      const activityPayloads = templateCommunicationMeta.map((meta) => {
        const communicationsForTemplate = savedCommunications.slice(meta.startIndex, meta.endIndex);
        const communicationIds = communicationsForTemplate.map((doc) => doc._id);
        const numbersList = meta.numbers.join(', ');
        const statusLabel = meta.status === 'success' ? 'sent' : 'failed';
        const comment = `SMS "${meta.template.name}" ${statusLabel} to ${numbersList}`;

        return {
          leadId: lead._id,
          type: 'comment',
          comment,
          performedBy: req.user._id,
          metadata: {
            communicationType: 'sms',
            templateId: meta.template._id,
            templateName: meta.template.name,
            templateLanguage: meta.template.language,
            numbers: meta.numbers,
            status: meta.status,
            messageIds: meta.apiResponse?.messageIds || [],
            error: meta.errorMessage,
            communicationIds,
          },
        };
      });

      if (activityPayloads.length > 0) {
        await ActivityLog.insertMany(activityPayloads, { ordered: false });
      }
    }

    const communications = savedCommunications.map((doc) => doc.toObject());

    return successResponse(
      res,
      {
        results,
        communications,
      },
      'SMS dispatch processed'
    );
  } catch (error) {
    console.error('Error sending SMS:', error);
    return errorResponse(res, error.message || 'Failed to send SMS', 500);
  }
};

export const getLeadCommunications = async (req, res) => {
  try {
    const { leadId } = req.params;
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 25;
    const type = req.query.type;

    if (!ObjectId.isValid(leadId)) {
      return errorResponse(res, 'Invalid lead ID', 400);
    }

    const filter = { leadId: new ObjectId(leadId) };

    if (type && ['call', 'sms'].includes(type)) {
      filter.type = type;
    }

    const skip = (page - 1) * limit;

    const [total, items] = await Promise.all([
      Communication.countDocuments(filter),
      Communication.find(filter)
        .sort({ sentAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate('sentBy', 'name email roleName')
        .lean(),
    ]);

    return successResponse(res, {
      items,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error('Error fetching lead communications:', error);
    return errorResponse(res, error.message || 'Failed to fetch communications', 500);
  }
};

export const getLeadCommunicationStats = async (req, res) => {
  try {
    const { leadId } = req.params;

    if (!ObjectId.isValid(leadId)) {
      return errorResponse(res, 'Invalid lead ID', 400);
    }

    const aggregation = await Communication.aggregate([
      { $match: { leadId: new ObjectId(leadId) } },
      {
        $group: {
          _id: '$contactNumber',
          callCount: {
            $sum: {
              $cond: [{ $eq: ['$type', 'call'] }, 1, 0],
            },
          },
          smsCount: {
            $sum: {
              $cond: [{ $eq: ['$type', 'sms'] }, 1, 0],
            },
          },
          lastContactedAt: { $max: '$sentAt' },
          lastCallAt: {
            $max: {
              $cond: [{ $eq: ['$type', 'call'] }, '$sentAt', null],
            },
          },
          lastSmsAt: {
            $max: {
              $cond: [{ $eq: ['$type', 'sms'] }, '$sentAt', null],
            },
          },
          templates: {
            $push: {
              templateId: '$template.templateId',
              templateName: '$template.name',
              sentAt: '$sentAt',
              status: '$status',
            },
          },
        },
      },
      { $sort: { lastContactedAt: -1 } },
    ]);

    const stats = aggregation.map((item) => {
      const templateUsageMap = new Map();

      item.templates
        .filter((tmpl) => tmpl.templateId)
        .forEach((tmpl) => {
          const key = tmpl.templateId.toString();
          if (!templateUsageMap.has(key)) {
            templateUsageMap.set(key, {
              templateId: tmpl.templateId,
              templateName: tmpl.templateName,
              count: 0,
            });
          }
          const entry = templateUsageMap.get(key);
          entry.count += 1;
        });

      return {
        contactNumber: item._id,
        callCount: item.callCount,
        smsCount: item.smsCount,
        lastContactedAt: item.lastContactedAt,
        lastCallAt: item.lastCallAt,
        lastSmsAt: item.lastSmsAt,
        templateUsage: Array.from(templateUsageMap.values()),
      };
    });

    return successResponse(res, {
      stats,
    });
  } catch (error) {
    console.error('Error fetching communication stats:', error);
    return errorResponse(res, error.message || 'Failed to fetch communication stats', 500);
  }
};

