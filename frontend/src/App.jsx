// App.jsx
import React, { useState } from 'react';
import './App.css'
import { Upload, Download, Search, AlertCircle, CheckCircle, Loader } from 'lucide-react';


function App() {
  const [file, setFile] = useState(null);
  const [allData, setAllData] = useState([]);
  const [needsScrapingData, setNeedsScrapingData] = useState([]);
  const [stats, setStats] = useState(null);
  const [processing, setProcessing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [logs, setLogs] = useState([]);
  const [completed, setCompleted] = useState(false);
  const [county, setCounty] = useState('');
  const [city, setCity] = useState('');

  const API_BASE_URL = 'http://localhost:3001/api';
// const API_BASE_URL = 'http://167.71.81.58/api/mortgage-lender';

  const addLog = (message, type = 'info') => {
    setLogs(prev => [...prev, { message, type, time: new Date().toLocaleTimeString() }]);
  };

  const handleFileUpload = async (e) => {
    const uploadedFile = e.target.files[0];
    if (!uploadedFile) return;

    setFile(uploadedFile);
    addLog('Parsing CSV file...', 'info');
    
    const formData = new FormData();
    formData.append('file', uploadedFile);

    try {
      const response = await fetch(`${API_BASE_URL}/parse-csv`, {
        method: 'POST',
        body: formData
      });

      if (!response.ok) {
        throw new Error('Failed to parse CSV');
      }

      const result = await response.json();
      
      setAllData(result.allRealtors);
      setNeedsScrapingData(result.needsScraping);
      setStats(result.stats);
      setCounty(result.county || '');
      setCity(result.city || '');
      
      addLog(`Loaded ${result.stats.total} mortgage lenders from CSV`, 'success');
      addLog(`${result.stats.hasComplete} already have contact info`, 'info');
      addLog(`${result.stats.needsScraping} need scraping`, 'warning');
    } catch (error) {
      addLog(`Error parsing CSV: ${error.message}`, 'error');
    }
  };

  const waitForJob = async (jobId) => {
  while (true) {
    await new Promise(r => setTimeout(r, 2000));

    const res = await fetch(`${API_BASE_URL}/job-status/${jobId}`);
    if (!res.ok) throw new Error('Failed to fetch job status');

    const job = await res.json();

    if (job.status === 'completed') {
      return job.result;
    }

    if (job.status === 'failed') {
      throw new Error(job.error || 'Scraping failed');
    }
  }
};


  const startScraping = async () => {
    if (needsScrapingData.length === 0) {
      addLog('No mortgage lenders need scraping. All have contact info!', 'success');
      return;
    }

    setProcessing(true);
    setCompleted(false);
    setLogs([]);
    addLog(`Starting scraping process for ${needsScrapingData.length} mortgage lenders`, 'info');

    const updatedAllData = [...allData];

    for (let i = 0; i < needsScrapingData.length; i++) {
  const realtor = needsScrapingData[i];
  addLog(`Searching: ${realtor.firstName} ${realtor.lastName}`, 'info');

  try {
    const startRes = await fetch(`${API_BASE_URL}/scrape-realtor`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ realtor })
    });

    if (!startRes.ok) {
      throw new Error('Failed to start scraping job');
    }

    const { jobId } = await startRes.json();
    const result = await waitForJob(jobId);

    const allIndex = updatedAllData.findIndex(r =>
      r.firstName === realtor.firstName &&
      r.lastName === realtor.lastName &&
      r.company === realtor.company
    );

    if (allIndex !== -1) {
      updatedAllData[allIndex] = result;
    }

    if (result.work_email || result.mobile_phone) {
      addLog(
        `Found: ${result.work_email || result.mobile_phone} (${result.confidence}% confidence)`,
        'success'
      );
    } else {
      addLog(`No contact info found for ${realtor.firstName} ${realtor.lastName}`, 'warning');
    }

  } catch (error) {
    addLog(
      `Error processing ${realtor.firstName} ${realtor.lastName}: ${error.message}`,
      'error'
    );
  }

  setProgress(((i + 1) / needsScrapingData.length) * 100);
}


    setAllData(updatedAllData);
    
    addLog('Scraping completed! Starting filtering and DNC check...', 'success');
    
    // Process realtors for filtering and DNC check
    await processRealtorsForFiltering(updatedAllData);
  };

  const processRealtorsForFiltering = async (realtorsData) => {
    try {
      addLog('Starting production filtering and DNC check...', 'info');
      
      const processedRealtors = [...realtorsData];
      
      // Process each realtor one by one to show progress
      for (let i = 0; i < realtorsData.length; i++) {
        try {
          const response = await fetch(`${API_BASE_URL}/process-realtors`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              realtors: realtorsData,
              index: i
            })
          });

          if (!response.ok) {
            const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
            throw new Error(errorData.error || `HTTP ${response.status}`);
          }

          const result = await response.json();
          
          // Update the realtor in our array
          processedRealtors[i] = result.realtor;
          
          // Log the progress message from backend
          if (result.logMessage) {
            addLog(result.logMessage, result.logType || 'info');
          }
          
          // Update progress
          setProgress(((i + 1) / realtorsData.length) * 100);
        } catch (error) {
          addLog(`Error processing ${realtorsData[i]?.firstName} ${realtorsData[i]?.lastName}: ${error.message}`, 'error');
          processedRealtors[i] = realtorsData[i];
        }
      }
      
      setAllData(processedRealtors);
      
      const dncCount = processedRealtors.filter(r => r.tags?.includes('dnc')).length;
      
      addLog(`Filtering complete! ${dncCount} on DNC`, 'success');
      
      setProcessing(false);
      setCompleted(true);
      
      // Trigger n8n with the fully processed data
      await triggerN8nUpload(processedRealtors);
    } catch (error) {
      addLog(`Error processing mortgage lenders: ${error.message}`, 'error');
      setProcessing(false);
      setCompleted(true);
    }
  };

  const triggerN8nUpload = async (finalData) => {
    const headers = [
      'First Name', 
      'Last Name', 
      'Company', 
      'work_email', 
      'mobile_phone', 
      'personal_email', 
      'title', 
      'City', 
      'state',
      'trailing_14_units',
      'Tags'
    ];
    
    const rows = finalData.map(r => [
      r.firstName || '', 
      r.lastName || '', 
      r.company || '', 
      r.work_email || '', 
      r.mobile_phone || '',  
      r.personal_email || '',
      r.title || '',
      r.city || '',
      r.state || '',
      r.trailing_14_units || '',
      r.tags || ''
    ]);

    const csv = [headers, ...rows]
      .map(row => row.map(cell => {
        const cellStr = String(cell || '').replace(/"/g, '""');
        return `"${cellStr}"`;
      }).join(','))
      .join('\n');

    let filename = 'mortgage_lenders_with_contacts.csv';
    if (county) {
      filename = `${county}_County_mortgage_lenders_with_contacts.csv`;
    }

    const state = finalData[0]?.state;
    if (state) {
      addLog('Uploading to Google Drive and GoHighLevel...', 'info');
      
      try {
        const response = await fetch(`${API_BASE_URL}/trigger-upload`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            csvContent: csv,
            filename: filename,
            stateCode: state, 
            county: county,
            totalRealtors: finalData.length 
          })
        });

        const result = await response.json();
        
        if (response.ok && result.success) {
          addLog('Successfully uploaded to Google Drive!', 'success');
          addLog(`Processing ${finalData.length} contacts for GoHighLevel...`, 'success');
        } else {
          throw new Error(result.error || result.details || 'Upload failed');
        }
      } catch (error) {
        addLog(`Upload error: ${error.message}`, 'error');
        addLog('You can still download the CSV manually', 'info');
      }
    }
  };

  const downloadCSV = () => {
    const headers = [
      'First Name', 
      'Last Name', 
      'Company', 
      'work_email', 
      'mobile_phone', 
      'personal_email', 
      'title', 
      'City', 
      'state',
      'trailing_14_units',
      'Tags'
    ];
    
    const rows = allData.map(r => [
      r.firstName || '', 
      r.lastName || '', 
      r.company || '', 
      r.work_email || '', 
      r.mobile_phone || '',  
      r.personal_email || '',
      r.title || '',
      r.city || '',
      r.state || '',
      r.trailing_14_units || '',
      r.tags || ''
    ]);

    const csv = [headers, ...rows]
      .map(row => row.map(cell => {
        const cellStr = String(cell || '').replace(/"/g, '""');
        return `"${cellStr}"`;
      }).join(','))
      .join('\n');

    let filename = 'mortgage_lenders_with_contacts.csv';
    if (county) {
      filename = `${county}_County_mortgage_lenders_with_contacts.csv`;
    }

    const blob = new Blob([csv], { type: 'text/csv' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    window.URL.revokeObjectURL(url);
    
    addLog('CSV downloaded successfully', 'success');
  };

  return (
    <div className="min-h-screen ">
      <div className="max-w-4xl mx-auto">
        <div className="bg-white border-4 border-blue-500/100  shadow-xl p-8">
          <div className="flex items-center gap-3 mb-8 mx-auto">
            <h1 className="text-2xl font-bold text-gray-900">Mortgage Lender Contact Scraper</h1>
          </div>

          {/* File Upload */}
          <div className="mb-6">
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Upload CSV File
            </label>
            <div className="border-2 border-dashed border-gray-300  p-8 text-center hover:border-indigo-400 transition">
              <input
                type="file"
                accept=".csv"
                onChange={handleFileUpload}
                className="hidden"
                id="file-upload"
              />
              <label htmlFor="file-upload" className="cursor-pointer">
                <p className="text-gray-600">
                  {file ? file.name : 'Click to upload CSV file'}
                </p>
                <p className="text-sm text-gray-400 mt-2">CSV must contain first_name, last_name, and company columns</p>
              </label>
            </div>
          </div>

          {/* Data Preview */}
          {stats && (
            <div className="mb-6 ">
              <div className="grid grid-cols-2 gap-4 mb-4 ">
                <div className="bg-blue-100   p-4">
                  <div className="text-2xl font-bold text-blue-600">{stats.total}</div>
                  <div className="text-sm text-blue-800">Total Mortgage Lenders</div>
                </div>
                <div className="bg-orange-100  p-4">
                  <div className="text-2xl font-bold text-orange-600">{stats.needsScraping}</div>
                  <div className="text-sm text-orange-800">Need Scraping</div>
                </div>
              </div>
              
              {needsScrapingData.length > 0 && (
                <>
                  <h3 className="text-lg font-semibold mb-3 text-gray-800">
                    Mortgage Lenders Missing Contact Info ({needsScrapingData.length})
                  </h3>
                  <div className="bg-orange-100   p-4 max-h-48 overflow-y-auto">
                    {needsScrapingData.slice(0, 10).map((r, i) => (
                      <div key={i} className="text-sm text-gray-700 mb-2 flex justify-between">
                        <span className="font-medium">{r.firstName} {r.lastName}</span>
                        <span className="text-gray-500">{r.company}</span>
                        <span className="text-xs text-orange-600">
                          {!r.work_email && !r.mobile_phone ? 'No contact' : !r.work_email ? 'Missing email' : 'Missing phone'}
                        </span>
                      </div>
                    ))}
                    {needsScrapingData.length > 10 && (
                      <div className="text-sm text-gray-400 mt-2">...and {needsScrapingData.length - 10} more</div>
                    )}
                  </div>
                </>
              )}
              
              {needsScrapingData.length === 0 && (
                <div className="bg-green-200   p-4">
                  <p className="text-green-800 font-medium">All Mortgage Lenders have contact information</p>
                  <p className="text-sm text-green-700 mt-1">No scraping needed.</p>
                </div>
              )}
            </div>
          )}

          {/* Action Buttons */}
          <div className="flex gap-4 mb-6">
            <button
              onClick={startScraping}
              disabled={processing || needsScrapingData.length === 0 }
              className="flex-1 bg-indigo-600 text-white px-6 py-3  rounded-full font-semibold hover:bg-indigo-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition flex items-center justify-center gap-2"
            >
              {processing ? (
                <>
                  <Loader className="w-5 h-5 animate-spin" />
                  Processing...
                </>
              ) : (
                <>
                  Start Scraping ({needsScrapingData.length})
                </>
              )}
            </button>

            {completed && (
              <button
                onClick={downloadCSV}
                className="flex-1 bg-green-600 text-white px-6 py-3 rounded-full font-semibold hover:bg-green-700 transition flex items-center justify-center gap-2"
              >
                Download Results
              </button>
            )}
          </div>

          {/* Progress Bar */}
          {processing && (
            <div className="mb-6">
              <div className="w-full bg-gray-200 rounded-full h-3">
                <div
                  className="bg-indigo-600 h-3 rounded-full transition-all duration-300"
                  style={{ width: `${progress}%` }}
                />
              </div>
              <p className="text-sm text-gray-600 mt-2 text-center">
                {Math.round(progress)}% Complete
              </p>
            </div>
          )}

          {/* Logs */}
          {logs.length > 0 && (
            <div className="bg-gray-900  p-4 max-h-96 overflow-y-auto">
              <h3 className="text-white font-semibold mb-3 flex items-center gap-2">
                Activity Log
              </h3>
              {logs.map((log, i) => (
                <div key={i} className="flex items-start gap-2 mb-2 text-sm">
                  <span className="text-gray-500">[{log.time}]</span>
                  <span className={`
                    ${log.type === 'success' ? 'text-green-400' : ''}
                    ${log.type === 'error' ? 'text-red-400' : ''}
                    ${log.type === 'warning' ? 'text-yellow-400' : ''}
                    ${log.type === 'info' ? 'text-gray-300' : ''}
                  `}>
                    {log.message}
                  </span>
                </div>
              ))}
            </div>
          )}

          {/* Results Summary */}
          {completed && (
            <div className="mt-6 bg-green-100   p-4">
              <h3 className="font-semibold text-green-800 mb-2">Processing Complete!</h3>
              <div className="text-sm text-green-700">
                <p>Processed {needsScrapingData.length} mortgage lenders</p>
                <p className="mt-1">
                  Found Emails: {needsScrapingData.filter(r => r.email).length} | 
                  Found Phones: {needsScrapingData.filter(r => r.phone).length}
                </p>
                <p className="mt-2 text-xs">
                  Total in CSV: {allData.filter(r => r.email).length} emails, {allData.filter(r => r.phone).length} phones
                </p>
                <p className="mt-2 text-xs">
                  DNC List: {allData.filter(r => r.tags?.includes('dnc')).length}
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default App