// server.js
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const multer = require('multer');
const csv = require('csv-parser');
const { Readable } = require('stream');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' })); 
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// API keys
// const SERPAPI_KEY = process.env.SERPAPI_KEY; 
const SERPAPI_KEY ='2bd6055e24b0ab4236ba466cdad4a5db0a9cd545b5ac954cd4e7b982aefc5e6c';
// const RPV_API_TOKEN = process.env.RPV_API_TOKEN; 
const RPV_API_TOKEN = '2169AE51-9510-4D7F-ABA0-69A5F558B88B';
const N8N_WEBHOOK_URL = 'https://n8n.profitwithanthonyavallone.com/webhook/upload-mortgage-lenders'

// Regex patterns
const EMAIL_PATTERN = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g;
const PHONE_PATTERN = /(\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g;

// Helper Functions
function extractContactInfo(text) {
  const emails = [...new Set(text.match(EMAIL_PATTERN) || [])];
  const phones = [...new Set(text.match(PHONE_PATTERN) || [])];
  
  const filteredEmails = emails.filter(email => {
    const lower = email.toLowerCase();
    return !lower.includes('noreply') && 
           !lower.includes('support') && 
           !lower.includes('info@') &&
           !lower.includes('admin') &&
           !lower.includes('example') &&
           !lower.includes('test') &&
           !lower.includes('privacy') &&
           !lower.includes('abuse');
  });
  
  return {
    emails: filteredEmails.slice(0, 5),
    phones: phones.slice(0, 5)
  };
}

function extractCountyFromFilename(filename) {
  if (!filename) return '';
  
  const nameWithoutExt = filename.replace(/\.[^/.]+$/, '');
  const countyMatch = nameWithoutExt.match(/([A-Za-z\s]+)\s*county/i);
  
  if (countyMatch && countyMatch[1]) {
    return countyMatch[1].trim();
  }
  
  return '';
}

function cleanPhoneNumber(phone) {
  if (!phone) return '';
  // Remove all non-numeric xters
  return phone.replace(/\D/g, '');
}

function calculateConfidence(email, phone, source) {
  let score = 0;
  if (email) score += 50;
  if (phone) score += 40;
  if (source.includes('linkedin') || source.includes('realtor.com') || source.includes('zillow')) {
    score += 10;
  }
  return Math.min(score, 100);
}

// Check DNC status using RealPhoneValidator API
async function checkDNCStatus(phone) {
  if (!phone || !RPV_API_TOKEN) {
    return { isDNC: false, error: 'Missing phone or API token' };
  }

  const cleanPhone = cleanPhoneNumber(phone);
  
  if (cleanPhone.length !== 10) {
    return { isDNC: false, error: 'Invalid phone number length' };
  }

  try {
    const response = await axios.get('https://api.realvalidation.com/rpvWebService/DNCLookup.php', {
      params: {
        phone: cleanPhone,
        token: RPV_API_TOKEN,
        Output: 'json'
      },
      timeout: 10000
    });

    const data = response.data;
    
    console.log(`API Response for ${cleanPhone}:`, JSON.stringify(data));
    
    // Check for API error response
    if (data.RESPONSECODE === '-1') {
      return { 
        isDNC: false, 
        error: data.RESPONSEMSG || 'API returned error' 
      };
    }
    
    // Check for successful response
    if (data.RESPONSECODE === 'OK') {
      // Check if national_dnc is 'Y' (on DNC list)
      if (data.national_dnc === 'Y') {
        return {
          isDNC: true,
          nationalDNC: true,
          stateDNC: data.state_dnc === 'Y',
          isCell: data.iscell === 'Y',
          isLitigator: data.litigator === 'Y',
          id: data.id || ''
        };
      }
      
      // national_dnc is 'N' (not on DNC list)
      if (data.national_dnc === 'N') {
        return {
          isDNC: false,
          nationalDNC: false,
          stateDNC: data.state_dnc === 'Y',
          isCell: data.iscell === 'Y',
          isLitigator: data.litigator === 'Y',
          id: data.id || ''
        };
      }
    }
    
    // Unexpected response format
    return { isDNC: false, error: 'Unexpected API response format' };
  } catch (error) {
    console.error('DNC check error:', error.message);
    return { isDNC: false, error: error.message };
  }
}

async function searchSerpApiEnhanced(query, apiKey) {
  try {
    const response = await axios.get('https://serpapi.com/search.json', {
      params: {
        q: query,
        num: 20, 
        api_key: apiKey,
        hl: 'en',
        gl: 'us'
      },
      timeout: 15000
    });
    
    const results = [];
    const data = response.data;
    
    if (data.organic_results) {
      for (const result of data.organic_results) {
        results.push({
          url: result.link,
          title: result.title || '',
          snippet: result.snippet || '',
          type: 'organic'
        });
      }
    }
    
    if (data.knowledge_graph) {
      const kg = data.knowledge_graph;
      let kgText = [
        kg.title,
        kg.description,
        kg.phone,
        kg.email,
        JSON.stringify(kg.profiles),
        JSON.stringify(kg.contact)
      ].filter(Boolean).join(' ');
      
      results.push({
        url: kg.website || '',
        title: kg.title || '',
        snippet: kgText,
        type: 'knowledge_graph'
      });
    }
    
    if (data.local_results && data.local_results.places) {
      for (const place of data.local_results.places) {
        const placeText = [
          place.title,
          place.address,
          place.phone,
          place.website
        ].filter(Boolean).join(' ');
        
        results.push({
          url: place.website || '',
          title: place.title || '',
          snippet: placeText,
          type: 'local_business'
        });
      }
    }
    
    if (data.answer_box) {
      const ab = data.answer_box;
      const abText = [
        ab.answer,
        ab.title,
        ab.snippet
      ].filter(Boolean).join(' ');
      
      if (abText) {
        results.push({
          url: ab.link || '',
          title: ab.title || '',
          snippet: abText,
          type: 'answer_box'
        });
      }
    }
    
    return results;
  } catch (error) {
    console.error('SerpAPI error:', error.message);
    return [];
  }
}

async function tryScrapeSafe(url) {
  if (url.includes('linkedin.com') || 
      url.includes('zillow.com') || 
      url.includes('facebook.com')) {
    return null;
  }
  
  try {
    const response = await axios.get(url, {
      timeout: 8000,
      maxRedirects: 3,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'DNT': '1',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1'
      }
    });
    
    const $ = cheerio.load(response.data);
    $('script, style, noscript').remove();
    const text = $.text();
    
    return extractContactInfo(text);
  } catch (error) {
    return null;
  }
}

async function processRealtor(realtorData, apiKey) {
  const { firstName, lastName, company } = realtorData;
  
  const queries = [
    `${firstName} ${lastName} ${company} email phone contact`,
    `${firstName} ${lastName} ${company} email cell contact`,
    `${firstName} ${lastName} ${company} mortgage lender contact`,
    `${firstName} ${lastName} mortgage lender ${company}`,
    `"${firstName} ${lastName}" mortgage lender ${company}`
  ];
  
  const allContacts = {
    emails: [],
    phones: [],
    sources: []
  };
  
  try {
    for (const query of queries) {
      const searchResults = await searchSerpApiEnhanced(query, apiKey);
      
      for (const result of searchResults) {
        const snippetContact = extractContactInfo(
          `${result.title} ${result.snippet}`
        );
        
        if (snippetContact.emails.length > 0 || snippetContact.phones.length > 0) {
          allContacts.emails.push(...snippetContact.emails);
          allContacts.phones.push(...snippetContact.phones);
          allContacts.sources.push(result.url || 'search_snippet');
        }
      }
      
      if (allContacts.emails.length > 0 || allContacts.phones.length > 0) {
        break;
      }
      
      for (const result of searchResults.slice(0, 5)) {
        if (!result.url) continue;
        
        const scrapedContact = await tryScrapeSafe(result.url);
        
        if (scrapedContact && (scrapedContact.emails.length > 0 || scrapedContact.phones.length > 0)) {
          allContacts.emails.push(...scrapedContact.emails);
          allContacts.phones.push(...scrapedContact.phones);
          allContacts.sources.push(result.url);
        }
        
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      
      if (allContacts.emails.length > 0 || allContacts.phones.length > 0) {
        break;
      }
      
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    
    const uniqueEmails = [...new Set(allContacts.emails)];
    const uniquePhones = [...new Set(allContacts.phones)];
    
    const email = uniqueEmails[0] || '';
    const phone = uniquePhones[0] || '';
    const source = allContacts.sources[0] || '';
    const confidence = calculateConfidence(email, phone, source);
    
    return {
      firstName,
      lastName,
      company,
      work_email: email || realtorData.work_email || '',
      mobile_phone: cleanPhoneNumber(phone) || realtorData.mobile_phone || '', 
      personal_email: realtorData.personal_email || '',
      title: realtorData.title || '', 
      city: realtorData.city || '', 
      state: realtorData.state || '',
      trailing_14_units: realtorData.trailing_14_units || '', 
      tags: realtorData.tags || '',
      source,
      confidence
    };
  } catch (error) {
    console.error(`Error processing ${firstName} ${lastName}:`, error.message);
    return {
      firstName,
      lastName,
      company,
      work_email: realtorData.work_email || '',  
      mobile_phone: realtorData.mobile_phone || '', 
      personal_email: realtorData.personal_email || '',  
      title: realtorData.title || '',  
      city: realtorData.city || '',  
      state: realtorData.state || '',  
      trailing_14_units: realtorData.trailing_14_units || '', 
      tags: realtorData.tags || '',
      source: '',
      confidence: 0
    };
  }
}

// API Endpoints
app.post('/api/parse-csv', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    
    const allRealtors = [];
    const needsScraping = [];
    const buffer = req.file.buffer.toString('utf-8');
    
    const countyFromFile = extractCountyFromFilename(req.file.originalname);
    console.log('Extracted county from filename:', countyFromFile);
    
    await new Promise((resolve, reject) => {
      Readable.from(buffer)
        .pipe(csv({ trim: true, skip_empty_lines: true }))
        .on('data', (row) => {
          const keys = Object.keys(row);

          const normalize = (k) =>
            k.trim().toLowerCase().replace(/[_\s]/g, '');

          const firstNameKey = keys.find(k => normalize(k) === 'firstname');
          const lastNameKey  = keys.find(k => normalize(k) === 'lastname');
          const companyKey   = keys.find(k => normalize(k) === 'company');
          const workemailKey = keys.find(k => normalize(k) === 'workemail');
          const personalemailKey = keys.find(k => normalize(k) === 'personalemail');
          const mobilephoneKey = keys.find(k => normalize(k).includes('mobilephone'));
          const titleKey = keys.find(k => normalize(k) === 'title');
          const stateKey = keys.find(k => normalize(k) === 'state');
          const cityKey  = keys.find(k => normalize(k) === 'city');
          const trailing14Key = keys.find(k => normalize(k) === 'trailing14units');

          // console.log("last name", lastNameKey);
          const firstName = (row[firstNameKey] || '').trim();
          const lastName = (row[lastNameKey] || '').trim();
          const company = (row[companyKey] || '').trim();
          const work_email = (row[workemailKey] || '').trim();
          const mobile_phone = (row[mobilephoneKey] || '').trim();
          const personal_email = row[personalemailKey] || '';
          const title = row[titleKey] || '';
          const state = row[stateKey] || '';
          const city = row[cityKey] || '';
          const trailing_14_units = row.trailing_14_units || '';
          const county = countyFromFile; 
          let generatedTags = 'Mortgage Lender ';

          if (county && state) {
            generatedTags = `${county} county ${state} Mortgage Lender,${state} Mortgage Lender,Mortgage Lender`;
          } else if (state) {
            generatedTags = `${state} Mortgage Lender,Mortgage Lender`;
          }
          
            const realtor = {
              firstName: (row[firstNameKey] || '').trim(),
              lastName: (row[lastNameKey] || '').trim(),
              company: (row[companyKey] || '').trim(),
              work_email: (row[workemailKey] || '').trim(),
              mobile_phone: (row[mobilephoneKey] || '').trim(),
              personal_email: row[personalemailKey] || '',
              title: row[titleKey] || '',
              city: row[cityKey] || '',
              state: row[stateKey] || '',
              trailing_14_units: row[trailing14Key] || '',
              tags: generatedTags
            };
          
          allRealtors.push(realtor);
          
          if (!work_email || !mobile_phone) {
            needsScraping.push(realtor);
          }
        })
        .on('end', resolve)
        .on('error', reject);
    });
    
    console.log(`Total Mortgage Lender: ${allRealtors.length}`);
    console.log(`Need scraping: ${needsScraping.length}`);
    
    const firstCity = allRealtors.length > 0 ? allRealtors[0].city : '';

    res.json({ 
      allRealtors,
      needsScraping,
      stats: {
        total: allRealtors.length,
        needsScraping: needsScraping.length,
        hasComplete: allRealtors.length - needsScraping.length
      },
      county: countyFromFile,
      city: firstCity
    });
  } catch (error) {
    console.error('Parse error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/scrape-realtor', async (req, res) => {
  try {
    const { realtor } = req.body;

    if (!SERPAPI_KEY) {
      return res.status(500).json({ error: 'Server API key not configured' });
    }

    const apiKey = SERPAPI_KEY;
    
    if (!realtor) {
      return res.status(400).json({ error: 'Mortgage Lender data is required' });
    }
    
    const result = await processRealtor(realtor, apiKey);
    res.json(result);
  } catch (error) {
    console.error('Scrape endpoint error:', error); 
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/process-realtors', async (req, res) => {
  try {
    const { realtors, index } = req.body;
    
    if (!realtors || !Array.isArray(realtors)) {
      return res.status(400).json({ error: 'Mortgage Lender array is required' });
    }

    // If index is provided, process single realtor (for progress updates)
    if (index !== undefined) {
      try {
        const realtor = { ...realtors[index] };
        
        let logMessage = '';
        let logType = 'info';
        
        if (realtor.mobile_phone) {
          logMessage = `Checking DNC for ${realtor.firstName} ${realtor.lastName} (${realtor.mobile_phone})...`;
          logType = 'info';
          
          const dncResult = await checkDNCStatus(realtor.mobile_phone);
          
          console.log(`DNC Check Result for ${realtor.firstName} ${realtor.lastName}:`, dncResult);
          
          if (dncResult.error) {
            logMessage = `${realtor.firstName} ${realtor.lastName}: DNC check failed - ${dncResult.error}`;
            logType = 'warning';
          } else if (dncResult.isDNC === true) {
            const currentTags = realtor.tags || '';
            realtor.tags = currentTags ? `${currentTags},dnc` : 'dnc';
            logMessage = `${realtor.firstName} ${realtor.lastName}: On DNC list`;
            logType = 'error';
          } else {
            logMessage = `${realtor.firstName} ${realtor.lastName}: Clear - not on DNC`;
            logType = 'success';
          }
        }
        
        return res.json({ 
          realtor, 
          logMessage, 
          logType,
          index 
        });
      } catch (innerError) {
        console.error(`Error processing realtor at index ${index}:`, innerError);
        // Return the realtor unchanged if processing fails
        return res.json({
          realtor: realtors[index],
          logMessage: `${realtors[index].firstName} ${realtors[index].lastName}: Processing error - ${innerError.message}`,
          logType: 'error',
          index
        });
      }
    }

    // Batch processing (fallback)
    // console.log(`Processing ${realtors.length} realtors for filtering and DNC check...`);
    // const processedRealtors = [];

    // for (let i = 0; i < realtors.length; i++) {
    //   const realtor = { ...realtors[i] };
      
    //   if (realtor.mobile_phone) {
    //     const dncResult = await checkDNCStatus(realtor.mobile_phone);
        
    //     if (dncResult.isDNC === true) {
    //       const currentTags = realtor.tags || '';
    //       realtor.tags = currentTags ? `${currentTags},dnc` : 'dnc';
    //     }
        
    //     await new Promise(resolve => setTimeout(resolve, 500));
    //   }
      
    //   processedRealtors.push(realtor);
    // }

    console.log('Processing complete!');
    res.json({ processedRealtors });
  } catch (error) {
    console.error('Process Mortgage Lender error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.post('/api/trigger-upload', async (req, res) => {
  try {
    const { csvContent, filename, stateCode, county, totalRealtors } = req.body;
    
    if (!csvContent || !filename || !stateCode) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    
    console.log(`Triggering n8n workflow for ${filename}`);
    console.log(`State Code: ${stateCode}, County: ${county}`);
    console.log(`Total Mortgage Lenders: ${totalRealtors || 'unknown'}`);
    console.log(`CSV size: ${(csvContent.length / 1024).toFixed(2)} KB`);
    
    const response = await axios.post(N8N_WEBHOOK_URL, {
      csvContent,
      filename,
      stateCode,
      county,
      totalRealtors,
      timestamp: new Date().toISOString()
    }, {
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      timeout: 120000,
      maxContentLength: 50 * 1024 * 1024,
      maxBodyLength: 50 * 1024 * 1024,
      validateStatus: function (status) {
        return status >= 200 && status < 500;
      }
    });
    
    console.log('n8n response status:', response.status);
    
    if (response.headers['content-type']?.includes('text/html')) {
      console.error('n8n returned HTML error page');
      throw new Error('n8n webhook returned an error page. Check if workflow is active.');
    }
    
    if (response.status >= 400) {
      throw new Error(`n8n webhook failed with status ${response.status}`);
    }
    
    console.log('n8n upload successful');
    
    res.json({ 
      success: true, 
      message: 'Upload triggered successfully',
      n8nResponse: response.data 
    });
  } catch (error) {
    console.error('n8n trigger error:', {
      message: error.message,
      url: N8N_WEBHOOK_URL,
      code: error.code
    });
    
    res.status(500).json({ 
      error: error.message,
      details: 'Failed to trigger n8n workflow',
      webhookUrl: N8N_WEBHOOK_URL
    });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});