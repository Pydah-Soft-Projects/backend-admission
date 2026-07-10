import axios from 'axios';

export const handlePrintProxy = async (req, res) => {
  try {
    const { service } = req.params;
    if (!service) {
      return res.status(400).json({ success: false, message: 'Print service name is required' });
    }

    // Standardize service name to uppercase and underscore
    let serviceKey = service.toUpperCase().replace(/-/g, '_');
    if (serviceKey === 'FEES') serviceKey = 'FEE';

    const targetUrl = process.env[`${serviceKey}_PRINT_API_URL`];
    const targetKey = process.env[`${serviceKey}_PRINT_API_KEY`];

    if (!targetUrl || !targetKey) {
      console.error(`[Print Proxy] Configuration missing for service '${service}' (key: ${serviceKey})`);
      console.error(`  - ${serviceKey}_PRINT_API_URL: ${targetUrl ? 'configured' : 'MISSING'}`);
      console.error(`  - ${serviceKey}_PRINT_API_KEY: ${targetKey ? 'configured' : 'MISSING'}`);
      return res.status(404).json({
        success: false,
        message: `Print service '${service}' is not configured or not supported`
      });
    }

    // Build the request payload / query / headers
    const headers = {
      'Authorization': `Bearer ${targetKey}`,
      'Content-Type': req.headers['content-type'] || 'application/json',
      'X-Source-Application': process.env.PRINT_APP_NAME || 'admissions',
      'X-User-Id': String(req.user?.id || req.user?._id || ''),
      'X-User-Name': String(req.user?.name || req.user?.username || '')
    };

    console.log(`[Print Proxy] Forwarding ${req.method} request to ${targetUrl} for user ${req.user?.name} (${req.user?.id})`);

    // Call the external print service
    const response = await axios({
      method: req.method,
      url: targetUrl,
      headers,
      data: req.method !== 'GET' ? req.body : undefined,
      params: req.query,
      responseType: 'arraybuffer',
      timeout: 10000 // 10s timeout
    });

    // Forward headers from target service
    const contentType = response.headers['content-type'] || 'text/html';
    res.setHeader('Content-Type', contentType);
    
    // Check if attachment disposition is set, forward it too
    if (response.headers['content-disposition']) {
      res.setHeader('Content-Disposition', response.headers['content-disposition']);
    }

    console.log(`[Print Proxy] Successfully returned ${contentType} from ${service} service`);
    return res.send(response.data);
  } catch (error) {
    console.error(`[Print Proxy Error] Service: ${req.params?.service || 'unknown'}`, error.message);
    
    if (error.response) {
      const status = error.response.status;
      const contentType = error.response.headers['content-type'] || '';
      
      if (contentType.includes('application/json') && error.response.data) {
        try {
          const errorData = JSON.parse(error.response.data.toString());
          console.error(`[Print Proxy] External service returned error:`, errorData);
          return res.status(status).json({
            success: false,
            message: errorData.message || `Print service error: ${status}`
          });
        } catch {
          // ignore
        }
      }
      
      // CRITICAL: Convert 401/403 from external print service to 422 (not 400)
      // to avoid triggering frontend auto-logout on auth errors from the print service
      if (status === 401 || status === 403) {
        console.error(`[Print Proxy] External print service auth failed (${status}) - likely misconfigured API key for service: ${req.params?.service}`);
        return res.status(422).json({
          success: false,
          message: 'Print service authentication failed. Please contact support.'
        });
      }
      if (status === 404) {
        return res.status(404).json({
          success: false,
          message: 'Print template or record not found on target service'
        });
      }
      
      return res.status(status).json({
        success: false,
        message: `External print service failed with status ${status}`
      });
    } else if (error.code === 'ECONNABORTED' || error.message.includes('timeout')) {
      return res.status(504).json({
        success: false,
        message: 'Print service request timed out. Please try again later.'
      });
    } else if (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED') {
      return res.status(503).json({
        success: false,
        message: 'Print service is currently unavailable'
      });
    }
    
    return res.status(500).json({
      success: false,
      message: error.message || 'An unexpected error occurred during printing'
    });
  }
};
