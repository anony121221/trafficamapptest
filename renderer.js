// Web build note:
// - Set window.PROXY_BASE_URL (string) before renderer.js loads if you use a CORS/HLS proxy.
//   Example in index.html:
//     <script>window.PROXY_BASE_URL='https://YOUR-WORKER.your-subdomain.workers.dev/proxy?url=';</script>
//
const USER_AGENT = 'TrafficCameraMap/1.0 (contact@example.com)';
const MAPTILER_KEY = '5djJbPb4MYTxKyRjk3bn';
const REFRESH_INTERVAL = 5 * 60 * 1000; // 5 minutes

let map;
let currentPlayer = null;
let currentHls = null;
let imageRefreshInterval = null;
let allCameras = [];
let filteredCameras = [];
let markerClusterGroup;
let selectedCameraId = null;

// Weather layers
let mrmsLayer = null;
let mrmsActive = false;
let alertsActive = false;
let alertsLayerGroup = L.layerGroup();
let alertsInterval = null;

// Track broken video URLs to avoid retrying them
const brokenVideoUrls = new Set();

// For deduplication - key is "lat,lon"
const cameraLocationMap = new Map();

// DFW 511 Token Storage
let dfwToken = null;
let dfwTokenExpires = 0;

const stateMap = {
  'Alabama': 'AL', 'Alaska': 'AK', 'Arizona': 'AZ', 'Arkansas': 'AR', 'California': 'CA',
  'Colorado': 'CO', 'Connecticut': 'CT', 'Delaware': 'DE', 'Florida': 'FL', 'Georgia': 'GA',
  'Hawaii': 'HI', 'Idaho': 'ID', 'Illinois': 'IL', 'Indiana': 'IN', 'Iowa': 'IA',
  'Kansas': 'KS', 'Kentucky': 'KY', 'Louisiana': 'LA', 'Maine': 'ME', 'Maryland': 'MD',
  'Massachusetts': 'MA', 'Michigan': 'MI', 'Minnesota': 'MN', 'Mississippi': 'MS', 'Missouri': 'MO',
  'Montana': 'MT', 'Nebraska': 'NE', 'Nevada': 'NV', 'New Hampshire': 'NH', 'New Jersey': 'NJ',
  'New Mexico': 'NM', 'New York': 'NY', 'North Carolina': 'NC', 'North Dakota': 'ND', 'Ohio': 'OH',
  'Oklahoma': 'OK', 'Oregon': 'OR', 'Pennsylvania': 'PA', 'Rhode Island': 'RI', 'South Carolina': 'SC',
  'South Dakota': 'SD', 'Tennessee': 'TN', 'Texas': 'TX', 'Utah': 'UT', 'Vermont': 'VT',
  'Virginia': 'VA', 'Washington': 'WA', 'West Virginia': 'WV', 'Wisconsin': 'WI', 'Wyoming': 'WY'
};

function webMercatorToLatLon(x, y) {
  const R2D = 180 / Math.PI;
  const lon = x * R2D / 6378137.0;
  const lat = Math.atan(Math.sinh(y / 6378137.0)) * R2D;
  return { lat, lon };
}

function isValidUrl(url) {
  if (!url || typeof url !== 'string') return false;
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

let proxyBaseUrl = null;
let proxyBasePromise = null;

async function getProxyBaseUrl() {
  if (proxyBaseUrl) return proxyBaseUrl;
  if (typeof window !== 'undefined' && window.PROXY_BASE_URL) { proxyBaseUrl = window.PROXY_BASE_URL; return proxyBaseUrl; }
  const tauriInvoke =
    (window.__TAURI__ && window.__TAURI__.invoke)
    || (window.__TAURI__ && window.__TAURI__.tauri && window.__TAURI__.tauri.invoke)
    || (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke);
  if (!tauriInvoke) return null;
  if (!proxyBasePromise) {
    proxyBasePromise = tauriInvoke('proxy_base_url')
      .then((url) => {
        proxyBaseUrl = url;
        return url;
      })
      .catch(() => null);
  }
  return proxyBasePromise;
}

async function fetchJsonWithProxy(url, options = {}) {
  const proxy = await getProxyBaseUrl();
  const targetUrl = proxy ? `${proxy}${encodeURIComponent(url)}` : url;
  const response = await fetch(targetUrl, options);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function isHlsUrl(url) {
  return typeof url === 'string' && /\.m3u8(\?|$)/i.test(url);
}

function destroyCurrentVideo() {
  if (currentPlayer) {
    try { currentPlayer.dispose(); } catch (e) { console.warn('Video.js dispose error:', e); }
    currentPlayer = null;
  }
  if (currentHls) {
    try { currentHls.destroy(); } catch (e) { console.warn('HLS destroy error:', e); }
    currentHls = null;
  }
}

function initMap() {
  // PITCH BLACK MAP THEME
  map = L.map('map', { 
    zoomControl: false,
    minZoom: 4, 
    maxZoom: 18,
    maxBounds: null, 
    maxBoundsViscosity: 0.0,
    preferCanvas: true // Performance boost for rendering
  }).setView([39.8283, -98.5795], 5);
  
  // DARK TILE LAYER
  L.tileLayer(`https://api.maptiler.com/maps/streets-v2-dark/{z}/{x}/{y}.png?key=${MAPTILER_KEY}`, {
    attribution: '© MapTiler © OpenStreetMap contributors',
    maxZoom: 18,
    tileSize: 512,
    zoomOffset: -1,
    className: 'dark-tiles'
  }).addTo(map);
  
  // Set pitch black background
  map.getContainer().style.background = '#000';
  
  // Performance Optimization: chunkedLoading + aggressive clustering
  markerClusterGroup = L.markerClusterGroup({
    maxClusterRadius: 80,
    spiderfyOnMaxZoom: true,
    showCoverageOnHover: false,
    disableClusteringAtZoom: 16,
    chunkedLoading: true,
    chunkInterval: 100,
    chunkDelay: 25,
    animate: false,
    removeOutsideVisibleBounds: true,
    zoomToBoundsOnClick: true,
    iconCreateFunction: function(cluster) {
      const childCount = cluster.getChildCount();
      let size, color, fontSize;
      
      if (childCount < 10) {
        size = 40;
        color = 'rgba(74, 158, 255, 0.8)';
        fontSize = '12px';
      } else if (childCount < 50) {
        size = 50;
        color = 'rgba(41, 98, 255, 0.8)';
        fontSize = '13px';
      } else if (childCount < 200) {
        size = 60;
        color = 'rgba(26, 35, 126, 0.8)';
        fontSize = '14px';
      } else {
        size = 70;
        color = 'rgba(10, 26, 74, 0.8)';
        fontSize = '15px';
      }
      
      return L.divIcon({
        html: `<div style="background-color: ${color}; width: ${size}px; height: ${size}px; border-radius: 50%; display: flex; align-items: center; justify-content: center; color: white; font-weight: 600; font-size: ${fontSize}; border: 2px solid rgba(255,255,255,0.5); box-shadow: 0 2px 8px rgba(0,0,0,0.4);">${childCount}</div>`,
        className: 'marker-cluster-custom',
        iconSize: L.point(size, size),
        iconAnchor: L.point(size/2, size/2)
      });
    }
  });
  
  map.addLayer(markerClusterGroup);

  initWeatherLayers();
}

function initWeatherLayers() {
  console.log('Initializing weather layers...');
  mrmsLayer = L.tileLayer.wms('https://mesonet.agron.iastate.edu/cgi-bin/wms/nexrad/n0q.cgi', {
    layers: 'nexrad-n0q-900913',
    format: 'image/png',
    transparent: true,
    attribution: 'IEM NEXRAD',
    opacity: 0.7,
    tileSize: 512,
    crossOrigin: true,
    zIndex: 10
  });
  console.log('Weather layers initialized');
}

// Fetch and draw alerts with specific styles
async function fetchAndDrawAlerts() {
    const url = "https://api.weather.gov/alerts/active?event=Tornado%20Warning,Severe%20Thunderstorm%20Warning,Flash%20Flood%20Warning,Special%20Weather%20Statement,Tornado%20Watch,Severe%20Thunderstorm%20Watch&status=actual";
    try {
        const response = await fetch(url, { headers: {} });
        if(!response.ok) throw new Error("Alerts fetch failed");
        const data = await response.json();
        
        alertsLayerGroup.clearLayers(); // Clear old alerts

        const geoJsonLayer = L.geoJSON(data, {
            style: function(feature) {
                const eventType = feature.properties.event;
                let color = "#555555";
                let weight = 2;

                // Specific colors and weights requested
                if (eventType === "Tornado Watch") { color = "#ff0000"; weight = 2; }
                else if (eventType === "Severe Thunderstorm Watch") { color = "#ffff00"; weight = 2; }
                else if (eventType === "Tornado Warning") { color = "#8b0000"; weight = 4; } // Thicker
                else if (eventType === "Severe Thunderstorm Warning") { color = "#FFD700"; weight = 4; } // Bright Yellow/Gold as requested
                else if (eventType === "Flash Flood Warning") { color = "#006400"; weight = 4; } // Thicker (Green)
                else if (eventType === "Special Weather Statement") { color = "#d2b48c"; weight = 2; } // Tan

                return {
                    color: color,
                    weight: weight,
                    opacity: 1,
                    fillOpacity: 0 // NO FILL requested
                };
            },
            onEachFeature: function (feature, layer) {
                if (feature.properties && feature.properties.headline) {
                    // Minimalist popup content
                    const eventColor = layer.options.color || '#4a9eff';
                    const expires = new Date(feature.properties.expires).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                    const popupContent = `
                        <div class="alert-popup">
                            <div class="alert-header" style="border-left: 4px solid ${eventColor}; padding-left: 10px;">
                                <h4 class="alert-title">${feature.properties.event}</h4>
                                <span class="alert-time">Expires: ${expires}</span>
                            </div>
                            <div class="alert-body">
                                <p>${feature.properties.headline}</p>
                            </div>
                        </div>
                    `;
                    layer.bindPopup(popupContent, {
                        className: 'custom-alert-popup',
                        maxWidth: 320,
                        autoPan: true
                    });
                }
            }
        });
        
        alertsLayerGroup.addLayer(geoJsonLayer);
        
        if (alertsActive && !map.hasLayer(alertsLayerGroup)) {
            alertsLayerGroup.addTo(map);
        }

    } catch (e) {
        console.error("Failed to load weather alerts", e);
    }
}

function toggleMRMS(checked) {
  mrmsActive = checked;
  if (checked) {
    if(!map.hasLayer(mrmsLayer)) map.addLayer(mrmsLayer);
  } else {
    if(map.hasLayer(mrmsLayer)) map.removeLayer(mrmsLayer);
  }
}

function toggleAlerts(checked) {
    alertsActive = checked;
    if (checked) {
        fetchAndDrawAlerts(); // Fetch fresh data when turned on
        if (!map.hasLayer(alertsLayerGroup)) {
            alertsLayerGroup.addTo(map);
        }
        // Set an interval to refresh alerts every 2 minutes while active
        if (!alertsInterval) {
            alertsInterval = setInterval(fetchAndDrawAlerts, 120000);
        }
    } else {
        if (map.hasLayer(alertsLayerGroup)) {
            alertsLayerGroup.removeFrom(map);
        }
        if (alertsInterval) {
            clearInterval(alertsInterval);
            alertsInterval = null;
        }
    }
}

// --- DRAGGABLE LOGIC ---

function makeDraggable(element, handle) {
  let isDragging = false;
  let startX, startY, initialLeft, initialTop;

  handle.addEventListener('mousedown', (e) => {
    isDragging = true;
    startX = e.clientX;
    startY = e.clientY;
    const rect = element.getBoundingClientRect();
    element.style.bottom = 'auto';
    element.style.right = 'auto';
    element.style.left = `${rect.left}px`;
    element.style.top = `${rect.top}px`;
    initialLeft = rect.left;
    initialTop = rect.top;
    handle.style.cursor = 'grabbing';
  });

  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    e.preventDefault();
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    element.style.left = `${initialLeft + dx}px`;
    element.style.top = `${initialTop + dy}px`;
  });

  document.addEventListener('mouseup', () => {
    if (isDragging) {
      isDragging = false;
      handle.style.cursor = 'move';
    }
  });
}

// --- NEW CAMERA FUNCTIONS ---

async function fetchConnecticutCameras() {
  const url = 'https://raw.githubusercontent.com/anony121221/maps-data/refs/heads/main/Connecticut/ct.geojson';
  try {
    const res = await fetch(`${url}?v=${Date.now()}`, { headers: {}, cache: 'no-store' });
    if (!res.ok) throw new Error(`CT HTTP ${res.status}`);
    const data = await res.json();
    if (!data?.features?.length) return [];

    const cameras = [];
    data.features.forEach((f, idx) => {
      const p = f.properties || {};
      const c = f.geometry?.coordinates;
      if (!c || c.length < 2) return;

      const lat = parseFloat(c[1]);
      const lon = parseFloat(c[0]);
      if (isNaN(lat) || isNaN(lon)) return;

      const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
      if (cameraLocationMap.has(key)) return;

      const imageUrl = p.image_url || p.imageUrl || p.image;
      const videoUrl = isValidUrl(p.stream) ? p.stream : null;

      if (!imageUrl && !videoUrl) return;

      const hasVideo = !!videoUrl;
      const camera = {
        id: `CT-${p.cameraSiteId || p.id || idx}-${Math.random().toString(36).substr(2, 9)}`,
        name: p.location || p.name || p.title || `CT Camera ${idx}`,
        lat,
        lon,
        imageUrl,
        videoUrl,
        type: hasVideo ? 'video' : 'image',
        displayMode: hasVideo ? 'video' : 'image',
        state: 'CT',
        provider: 'CT Travel Smart'
      };

      cameras.push(camera);
      cameraLocationMap.set(key, camera);
    });

    return cameras;
  } catch (e) { console.error('CT Error', e); return []; }
}

async function fetchFloridaCameras() {
  const url = 'https://raw.githubusercontent.com/anony121221/maps-data/main/Florida/florida.geojson';
  try {
    const res = await fetch(`${url}?v=${Date.now()}`, { headers: {}, cache: 'no-store' });
    if (!res.ok) throw new Error(`FL HTTP ${res.status}`);
    const data = await res.json();
    if (!data?.features?.length) return [];

    const cameras = [];
    data.features.forEach((f, idx) => {
      const p = f.properties || {};
      const c = f.geometry?.coordinates;
      if (!c || c.length < 2) return;

      const lat = parseFloat(c[1]);
      const lon = parseFloat(c[0]);
      if (isNaN(lat) || isNaN(lon)) return;

      const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
      if (cameraLocationMap.has(key)) return;

      const imageUrl = p.imageUrl || p.image_url || p.image;
      if (!imageUrl) return;

      const camera = {
        id: `FL-${p.id || p.cameraSiteId || idx}-${Math.random().toString(36).substr(2, 9)}`,
        name: p.name || p.location || `FL Camera ${idx}`,
        lat,
        lon,
        imageUrl,
        videoUrl: null,
        type: 'image',
        displayMode: 'image',
        state: 'FL',
        provider: p.source || 'FL511'
      };

      cameras.push(camera);
      cameraLocationMap.set(key, camera);
    });

    return cameras;
  } catch (e) { console.error('FL Error', e); return []; }
}

async function fetchMaineCameras() {
  const url = 'https://raw.githubusercontent.com/anony121221/maps-data/refs/heads/main/Maine/maine.geojson';
  try {
    const res = await fetch(`${url}?v=${Date.now()}`, { headers: {}, cache: 'no-store' });
    if (!res.ok) throw new Error(`ME HTTP ${res.status}`);
    const data = await res.json();
    if (!data?.features?.length) return [];

    const cameras = [];
    data.features.forEach((f, idx) => {
      const p = f.properties || {};
      const c = f.geometry?.coordinates;
      if (!c || c.length < 2) return;

      const lat = parseFloat(c[1]);
      const lon = parseFloat(c[0]);
      if (isNaN(lat) || isNaN(lon)) return;

      const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
      if (cameraLocationMap.has(key)) return;

      const imageUrl = p.image || p.imageUrl;
      if (!imageUrl) return;

      const camera = {
        id: `ME-${p.id || idx}-${Math.random().toString(36).substr(2, 9)}`,
        name: p.location || p.road || `ME Camera ${idx}`,
        lat,
        lon,
        imageUrl,
        videoUrl: null,
        type: 'image',
        displayMode: 'image',
        state: 'ME',
        provider: 'Maine DOT'
      };

      cameras.push(camera);
      cameraLocationMap.set(key, camera);
    });

    return cameras;
  } catch (e) { console.error('ME Error', e); return []; }
}

async function fetchMassachusettsCameras() {
  const url = 'https://raw.githubusercontent.com/anony121221/maps-data/refs/heads/main/Massachusetts/Massachusetts.geojson';
  try {
    const res = await fetch(`${url}?v=${Date.now()}`, { headers: {}, cache: 'no-store' });
    if (!res.ok) throw new Error(`MA HTTP ${res.status}`);
    const data = await res.json();
    if (!data?.features?.length) return [];

    const cameras = [];
    data.features.forEach((f, idx) => {
      const p = f.properties || {};
      const c = f.geometry?.coordinates;
      if (!c || c.length < 2) return;

      const lat = parseFloat(c[1]);
      const lon = parseFloat(c[0]);
      if (isNaN(lat) || isNaN(lon)) return;

      const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
      if (cameraLocationMap.has(key)) return;

      const imageUrl = p.image;
      if (!imageUrl) return;

      const camera = {
        id: `MA-${p.id || idx}-${Math.random().toString(36).substr(2, 9)}`,
        name: p.title || p.tooltip || `MA Camera ${idx}`,
        lat,
        lon,
        imageUrl,
        videoUrl: null,
        type: 'image',
        displayMode: 'image',
        state: 'MA',
        provider: p.agency || 'MassDOT'
      };

      cameras.push(camera);
      cameraLocationMap.set(key, camera);
    });

    return cameras;
  } catch (e) { console.error('MA Error', e); return []; }
}

async function fetchIdahoCameras() {
  const url = 'https://raw.githubusercontent.com/anony121221/maps-data/refs/heads/main/Idaho/idaho.geojson';
  try {
    const res = await fetch(`${url}?v=${Date.now()}`, { headers: {}, cache: 'no-store' });
    if (!res.ok) throw new Error(`ID HTTP ${res.status}`);
    const data = await res.json();
    if (!data?.features?.length) return [];

    const cameras = [];
    data.features.forEach((f, idx) => {
      const p = f.properties || {};
      const c = f.geometry?.coordinates;
      if (!c || c.length < 2) return;

      const lat = parseFloat(c[1]);
      const lon = parseFloat(c[0]);
      if (isNaN(lat) || isNaN(lon)) return;

      const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
      if (cameraLocationMap.has(key)) return;

      const imageUrl = p.imageUrl || p.image;
      if (!imageUrl) return;

      const camera = {
        id: `ID-${p.id || p.cameraSiteId || idx}-${Math.random().toString(36).substr(2, 9)}`,
        name: p.name || p.location || `ID Camera ${idx}`,
        lat,
        lon,
        imageUrl,
        videoUrl: null,
        type: 'image',
        displayMode: 'image',
        state: 'ID',
        provider: p.source || 'ITD'
      };

      cameras.push(camera);
      cameraLocationMap.set(key, camera);
    });

    return cameras;
  } catch (e) { console.error('ID Error', e); return []; }
}

async function fetchMontanaCameras() {
  const url = 'https://raw.githubusercontent.com/anony121221/maps-data/refs/heads/main/Montana/montana.geojson';
  try {
    const res = await fetch(`${url}?v=${Date.now()}`, { headers: {}, cache: 'no-store' });
    if (!res.ok) throw new Error(`MT HTTP ${res.status}`);
    const data = await res.json();
    if (!data?.features?.length) return [];

    const cameras = [];
    data.features.forEach((f, idx) => {
      const p = f.properties || {};
      const c = f.geometry?.coordinates;
      if (!c || c.length < 2) return;

      const lat = parseFloat(c[1]);
      const lon = parseFloat(c[0]);
      if (isNaN(lat) || isNaN(lon)) return;

      const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
      if (cameraLocationMap.has(key)) return;

      const imageUrl = p.image;
      if (!imageUrl) return;

      const camera = {
        id: `MT-${p.camera_id || p.station_id || idx}-${Math.random().toString(36).substr(2, 9)}`,
        name: p.camera_name || p.station_description || `MT Camera ${idx}`,
        lat,
        lon,
        imageUrl,
        videoUrl: null,
        type: 'image',
        displayMode: 'image',
        state: 'MT',
        provider: 'Montana DOT'
      };

      cameras.push(camera);
      cameraLocationMap.set(key, camera);
    });

    return cameras;
  } catch (e) { console.error('MT Error', e); return []; }
}

async function fetchNewHampshireCameras() {
  const url = 'https://raw.githubusercontent.com/anony121221/maps-data/refs/heads/main/New%20Hampshire/nh.geojson';
  try {
    const res = await fetch(`${url}?v=${Date.now()}`, { headers: {}, cache: 'no-store' });
    if (!res.ok) throw new Error(`NH HTTP ${res.status}`);
    const data = await res.json();
    if (!data?.features?.length) return [];

    const cameras = [];
    data.features.forEach((f, idx) => {
      const p = f.properties || {};
      const c = f.geometry?.coordinates;
      if (!c || c.length < 2) return;

      const lat = parseFloat(c[1]);
      const lon = parseFloat(c[0]);
      if (isNaN(lat) || isNaN(lon)) return;

      const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
      if (cameraLocationMap.has(key)) return;

      const imageUrl = p.image || p.imageUrl;
      if (!imageUrl) return;

      const camera = {
        id: `NH-${p.id || idx}-${Math.random().toString(36).substr(2, 9)}`,
        name: p.location || p.road || `NH Camera ${idx}`,
        lat,
        lon,
        imageUrl,
        videoUrl: null,
        type: 'image',
        displayMode: 'image',
        state: 'NH',
        provider: 'NHDOT'
      };

      cameras.push(camera);
      cameraLocationMap.set(key, camera);
    });

    return cameras;
  } catch (e) { console.error('NH Error', e); return []; }
}

async function fetchNewYorkCameras() {
  const url = 'https://raw.githubusercontent.com/anony121221/maps-data/refs/heads/main/New%20York/newyork.geojson';
  try {
    const res = await fetch(`${url}?v=${Date.now()}`, { headers: {}, cache: 'no-store' });
    if (!res.ok) throw new Error(`NY HTTP ${res.status}`);
    const data = await res.json();
    if (!data?.features?.length) return [];

    const cameras = [];
    data.features.forEach((f, idx) => {
      const p = f.properties || {};
      const c = f.geometry?.coordinates;
      if (!c || c.length < 2) return;

      const lat = parseFloat(c[1]);
      const lon = parseFloat(c[0]);
      if (isNaN(lat) || isNaN(lon)) return;

      const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
      if (cameraLocationMap.has(key)) return;

      const imageUrl = p.imageUrl || p.image || p.image_url;
      const videoUrl = isValidUrl(p.videoUrl) ? p.videoUrl : null;
      if (!imageUrl && !videoUrl) return;

      const hasVideo = !!videoUrl && p.hasVideo !== false;
      const camera = {
        id: `NY-${p.cameraSiteId || p.id || idx}-${Math.random().toString(36).substr(2, 9)}`,
        name: p.location || p.title || `NY Camera ${idx}`,
        lat,
        lon,
        imageUrl,
        videoUrl: hasVideo ? videoUrl : null,
        type: hasVideo ? 'video' : 'image',
        displayMode: hasVideo ? 'video' : 'image',
        state: 'NY',
        provider: p.source || 'NYSDOT'
      };

      cameras.push(camera);
      cameraLocationMap.set(key, camera);
    });

    return cameras;
  } catch (e) { console.error('NY Error', e); return []; }
}

async function fetchOregonCameras() {
  const url = 'https://raw.githubusercontent.com/anony121221/maps-data/refs/heads/main/Oregon/oregon.geojson';
  try {
    const res = await fetch(`${url}?v=${Date.now()}`, { headers: {}, cache: 'no-store' });
    if (!res.ok) throw new Error(`OR HTTP ${res.status}`);
    const data = await res.json();
    if (!data?.features?.length) return [];

    const cameras = [];
    data.features.forEach((f, idx) => {
      const p = f.properties || {};
      const c = f.geometry?.coordinates;
      if (!c || c.length < 2) return;

      const lat = parseFloat(c[1]);
      const lon = parseFloat(c[0]);
      if (isNaN(lat) || isNaN(lon)) return;

      const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
      if (cameraLocationMap.has(key)) return;

      const imageUrl = p.image;
      if (!imageUrl) return;

      const camera = {
        id: `OR-${p.id || idx}-${Math.random().toString(36).substr(2, 9)}`,
        name: p.description || p.name || `OR Camera ${idx}`,
        lat,
        lon,
        imageUrl,
        videoUrl: null,
        type: 'image',
        displayMode: 'image',
        state: 'OR',
        provider: 'ODOT'
      };

      cameras.push(camera);
      cameraLocationMap.set(key, camera);
    });

    return cameras;
  } catch (e) { console.error('OR Error', e); return []; }
}

async function fetchPennsylvaniaCameras() {
  const url = 'https://raw.githubusercontent.com/anony121221/maps-data/refs/heads/main/Pennsylvania/penndot.geojson';
  try {
    const res = await fetch(`${url}?v=${Date.now()}`, { headers: {}, cache: 'no-store' });
    if (!res.ok) throw new Error(`PA HTTP ${res.status}`);
    const data = await res.json();
    if (!data?.features?.length) return [];

    const cameras = [];
    data.features.forEach((f, idx) => {
      const p = f.properties || {};
      const c = f.geometry?.coordinates;
      if (!c || c.length < 2) return;

      const lat = parseFloat(c[1]);
      const lon = parseFloat(c[0]);
      if (isNaN(lat) || isNaN(lon)) return;

      const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
      if (cameraLocationMap.has(key)) return;

      const imageUrl = p.imageUrl || p.image || p.image_url;
      if (!imageUrl) return;

      const camera = {
        id: `PA-${p.id || p.cameraSiteId || idx}-${Math.random().toString(36).substr(2, 9)}`,
        name: p.name || p.location || `PA Camera ${idx}`,
        lat,
        lon,
        imageUrl,
        videoUrl: null, // PennDOT restriction: images only
        type: 'image',
        displayMode: 'image',
        state: 'PA',
        provider: 'PennDOT'
      };

      cameras.push(camera);
      cameraLocationMap.set(key, camera);
    });

    return cameras;
  } catch (e) { console.error('PA Error', e); return []; }
}

async function fetchRhodeIslandCameras() {
  const url = 'https://raw.githubusercontent.com/anony121221/maps-data/refs/heads/main/Rhode%20Island/ri.geojson';
  try {
    const res = await fetch(`${url}?v=${Date.now()}`, { headers: {}, cache: 'no-store' });
    if (!res.ok) throw new Error(`RI HTTP ${res.status}`);
    const data = await res.json();
    if (!data?.features?.length) return [];

    const cameras = [];
    data.features.forEach((f, idx) => {
      const p = f.properties || {};
      const c = f.geometry?.coordinates;
      if (!c || c.length < 2) return;

      const lat = parseFloat(c[1]);
      const lon = parseFloat(c[0]);
      if (isNaN(lat) || isNaN(lon)) return;

      const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
      if (cameraLocationMap.has(key)) return;

      const imageUrl = p.image || p.imageUrl;
      const videoUrl = isValidUrl(p.stream) ? p.stream : null;
      if (!imageUrl && !videoUrl) return;

      const hasVideo = !!videoUrl;
      const camera = {
        id: `RI-${p.id || idx}-${Math.random().toString(36).substr(2, 9)}`,
        name: p.location || p.road || `RI Camera ${idx}`,
        lat,
        lon,
        imageUrl,
        videoUrl,
        type: hasVideo ? 'video' : 'image',
        displayMode: hasVideo ? 'video' : 'image',
        state: 'RI',
        provider: p.agency || 'RIDOT'
      };

      cameras.push(camera);
      cameraLocationMap.set(key, camera);
    });

    return cameras;
  } catch (e) { console.error('RI Error', e); return []; }
}

async function fetchVermontCameras() {
  const url = 'https://raw.githubusercontent.com/anony121221/maps-data/refs/heads/main/Vermont/vermont.geojson';
  try {
    const res = await fetch(`${url}?v=${Date.now()}`, { headers: {}, cache: 'no-store' });
    if (!res.ok) throw new Error(`VT HTTP ${res.status}`);
    const data = await res.json();
    if (!data?.features?.length) return [];

    const cameras = [];
    data.features.forEach((f, idx) => {
      const p = f.properties || {};
      const c = f.geometry?.coordinates;
      if (!c || c.length < 2) return;

      const lat = parseFloat(c[1]);
      const lon = parseFloat(c[0]);
      if (isNaN(lat) || isNaN(lon)) return;

      const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
      if (cameraLocationMap.has(key)) return;

      const imageUrl = p.image || p.imageUrl;
      if (!imageUrl) return;

      const camera = {
        id: `VT-${p.id || idx}-${Math.random().toString(36).substr(2, 9)}`,
        name: p.location || p.road || `VT Camera ${idx}`,
        lat,
        lon,
        imageUrl,
        videoUrl: null,
        type: 'image',
        displayMode: 'image',
        state: 'VT',
        provider: p.agency || 'VTrans'
      };

      cameras.push(camera);
      cameraLocationMap.set(key, camera);
    });

    return cameras;
  } catch (e) { console.error('VT Error', e); return []; }
}

async function fetchWashingtonCameras() {
  const url = 'https://raw.githubusercontent.com/anony121221/maps-data/refs/heads/main/Washington/washington.geojson';
  try {
    const res = await fetch(`${url}?v=${Date.now()}`, { headers: {}, cache: 'no-store' });
    if (!res.ok) throw new Error(`WA HTTP ${res.status}`);
    const data = await res.json();
    if (!data?.features?.length) return [];

    const cameras = [];
    data.features.forEach((f, idx) => {
      const p = f.properties || {};
      const c = f.geometry?.coordinates;
      if (!c || c.length < 2) return;

      const lat = parseFloat(c[1]);
      const lon = parseFloat(c[0]);
      if (isNaN(lat) || isNaN(lon)) return;

      const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
      if (cameraLocationMap.has(key)) return;

      const imageUrl = p.image || p.imageUrl;
      if (!imageUrl) return;

      const camera = {
        id: `WA-${p.id || idx}-${Math.random().toString(36).substr(2, 9)}`,
        name: p.title || p.description || p.owner || `WA Camera ${idx}`,
        lat,
        lon,
        imageUrl,
        videoUrl: null,
        type: 'image',
        displayMode: 'image',
        state: 'WA',
        provider: 'WSDOT'
      };

      cameras.push(camera);
      cameraLocationMap.set(key, camera);
    });

    return cameras;
  } catch (e) { console.error('WA Error', e); return []; }
}

async function fetchNebraskaCameras() {
  const url = 'https://raw.githubusercontent.com/anony121221/maps-data/refs/heads/main/Nebraska/nebraska.geojson';
  try {
    const res = await fetch(`${url}?v=${Date.now()}`, { headers: {}, cache: 'no-store' });
    if (!res.ok) throw new Error(`NE HTTP ${res.status}`);
    const data = await res.json();
    if (!data?.features?.length) return [];
    
    const cameras = [];
    data.features.forEach((f, idx) => {
      const p = f.properties || {};
      const c = f.geometry?.coordinates;
      if (!c || c.length < 2) return;
      if (p.active === false) return;

      const lat = parseFloat(c[1]);
      const lon = parseFloat(c[0]);
      const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
      if (cameraLocationMap.has(key)) return;

      let views = [];
      let mainImage = null;

      if (Array.isArray(p.views) && p.views.length > 0) {
        views = p.views.map((url, i) => ({
          description: `View ${i + 1}`,
          imageUrl: url,
          videoUrl: null
        }));
        mainImage = views[0].imageUrl;
      } else if (p.imageURL || p.url) {
        mainImage = p.imageURL || p.url;
      }

      if (!mainImage) return;

      const camera = {
        id: `NE-${p.id || idx}-${Math.random().toString(36).substr(2, 9)}`,
        name: p.title || `NE Camera ${idx}`,
        lat: lat,
        lon: lon,
        views: views.length > 0 ? views : null,
        imageUrl: mainImage,
        videoUrl: null, 
        type: 'image',
        state: 'NE',
        provider: 'Nebraska 511'
      };
      cameras.push(camera);
      cameraLocationMap.set(key, camera);
    });
    return cameras;
  } catch (e) { console.error('NE Error', e); return []; }
}

async function fetchNorthCarolinaCameras() {
  const url = 'https://raw.githubusercontent.com/anony121221/maps-data/refs/heads/main/North%20Carolina/nc.geojson';
  try {
    const res = await fetch(`${url}?v=${Date.now()}`, { headers: {}, cache: 'no-store' });
    if (!res.ok) throw new Error(`NC HTTP ${res.status}`);
    const data = await res.json();
    if (!data?.features?.length) return [];
    
    const cameras = [];
    data.features.forEach((f, idx) => {
      const p = f.properties || {};
      const c = f.geometry?.coordinates;
      if (!c || c.length < 2 || !p.imageURL) return;
      
      const lat = parseFloat(c[1]);
      const lon = parseFloat(c[0]);
      const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
      if (cameraLocationMap.has(key)) return;

      const camera = {
        id: `NC-${p.id || idx}-${Math.random().toString(36).substr(2, 9)}`,
        name: p.name || `NC Camera ${idx}`,
        lat: lat,
        lon: lon,
        videoUrl: null,
        imageUrl: p.imageURL,
        type: 'image',
        state: 'NC',
        provider: 'NCDOT'
      };
      cameras.push(camera);
      cameraLocationMap.set(key, camera);
    });
    return cameras;
  } catch (e) { console.error('NC Error', e); return []; }
}

async function fetchSouthCarolinaCameras() {
  const url = 'https://raw.githubusercontent.com/anony121221/maps-data/refs/heads/main/South%20Carolina/sc.geojson';
  try {
    const res = await fetch(`${url}?v=${Date.now()}`, { headers: {}, cache: 'no-store' });
    if (!res.ok) throw new Error(`SC HTTP ${res.status}`);
    const data = await res.json();
    if (!data?.features?.length) return [];
    
    const cameras = [];
    data.features.forEach((f, idx) => {
      const p = f.properties || {};
      const c = f.geometry?.coordinates;
      if (!c || c.length < 2) return;
      
      const vid = p.https_url || p.ios_url; 
      const img = p.image_url;
      
      if (!vid && !img) return;

      const lat = parseFloat(c[1]);
      const lon = parseFloat(c[0]);
      const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
      if (cameraLocationMap.has(key)) return;

      const camera = {
        id: `SC-${p.id || idx}-${Math.random().toString(36).substr(2, 9)}`,
        name: p.description || p.name || `SC Camera ${idx}`,
        lat: lat,
        lon: lon,
        videoUrl: isValidUrl(vid) ? vid : null,
        imageUrl: img,
        type: (vid && isValidUrl(vid)) ? 'video' : 'image',
        state: 'SC',
        provider: 'SCDOT'
      };
      cameras.push(camera);
      cameraLocationMap.set(key, camera);
    });
    return cameras;
  } catch (e) { console.error('SC Error', e); return []; }
}

async function fetchTennesseeCameras() {
  const url = 'https://raw.githubusercontent.com/anony121221/maps-data/refs/heads/main/Tennessee/tennessee.geojson';
  try {
    const res = await fetch(`${url}?v=${Date.now()}`, { headers: {}, cache: 'no-store' });
    if (!res.ok) throw new Error(`TN HTTP ${res.status}`);
    const data = await res.json();
    if (!data?.features?.length) return [];
    
    const cameras = [];
    data.features.forEach((f, idx) => {
      const p = f.properties || {};
      const c = f.geometry?.coordinates;
      if (!c || c.length < 2) return;
      
      const vid = p.httpsVideoUrl || p.httpVideoUrl;
      const img = p.thumbnailUrl;
      
      if (!vid && !img) return;

      const lat = parseFloat(c[1]);
      const lon = parseFloat(c[0]);
      const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
      if (cameraLocationMap.has(key)) return;

      const camera = {
        id: `TN-${p.id || idx}-${Math.random().toString(36).substr(2, 9)}`,
        name: p.title || p.description || `TN Camera ${idx}`,
        lat: lat,
        lon: lon,
        videoUrl: isValidUrl(vid) ? vid : null,
        imageUrl: img,
        type: (vid && isValidUrl(vid)) ? 'video' : 'image',
        state: 'TN',
        provider: 'TDOT'
      };
      cameras.push(camera);
      cameraLocationMap.set(key, camera);
    });
    return cameras;
  } catch (e) { console.error('TN Error', e); return []; }
}

async function fetchUtahCameras() {
  const apiKey = 'e604011844504d6bb17c5a68339b2a41';
  const url = `https://www.udottraffic.utah.gov/api/v2/get/cameras?key=${apiKey}&format=json`;
  try {
    const response = await fetch(url, { headers: {}});
    if (!response.ok) throw new Error(`UT HTTP ${response.status}`);
    const data = await response.json();
    let list = [];
    if (Array.isArray(data)) list = data;
    else if (data && Array.isArray(data.cameras)) list = data.cameras;
    else if (data && data.result && Array.isArray(data.result)) list = data.result;

    const cameras = [];
    list.forEach(cam => {
      let lat = cam.latitude || cam.Latitude;
      let lon = cam.longitude || cam.Longitude;
      if (!lat && cam.location && typeof cam.location === 'object') {
        lat = cam.location.latitude || cam.location.Latitude;
        lon = cam.location.longitude || cam.location.Longitude;
      }
      lat = parseFloat(lat);
      lon = parseFloat(lon);
      if (!lat || !lon) return;

      const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
      if (cameraLocationMap.has(key)) return;

      const views = cam.views || cam.Views;
      let imageUrl = null;
      if (Array.isArray(views) && views.length > 0) imageUrl = views[0].url || views[0].Url || views[0].imageUrl;
      else imageUrl = cam.url || cam.Url || cam.imageUrl;

      if (!imageUrl) return;

      const camera = {
        id: `UT-${cam.id || cam.Id}-${Math.random().toString(36).substr(2, 9)}`,
        name: cam.location || cam.Location || `UT Camera ${cam.id}`,
        lat: lat,
        lon: lon,
        videoUrl: null,
        imageUrl: imageUrl,
        type: 'image',
        state: 'UT',
        provider: 'UDOT'
      };
      cameras.push(camera);
      cameraLocationMap.set(key, camera);
    });
    return cameras;
  } catch (e) { console.warn('UT Error', e); return []; }
}

async function fetchNevadaCameras() {
  const apiKey = 'd8ed5f99532a4fefa897533d33fcc235';
  const url = `https://www.nvroads.com/api/v2/get/cameras?key=${apiKey}&format=json`;
  try {
    const response = await fetch(url, { headers: {}});
    if (!response.ok) throw new Error(`NV HTTP ${response.status}`);
    const data = await response.json();
    let list = [];
    if (Array.isArray(data)) list = data;
    else if (data && Array.isArray(data.cameras)) list = data.cameras;

    const cameras = [];
    list.forEach(cam => {
      let lat = cam.latitude || cam.Latitude;
      let lon = cam.longitude || cam.Longitude;
      if (!lat && cam.location && typeof cam.location === 'object') {
        lat = cam.location.latitude || cam.location.Latitude;
        lon = cam.location.longitude || cam.location.Longitude;
      }
      lat = parseFloat(lat);
      lon = parseFloat(lon);
      if (!lat || !lon) return;

      const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
      if (cameraLocationMap.has(key)) return;

      let imageUrl = null;
      const views = cam.views || cam.Views;
      if (Array.isArray(views) && views.length > 0) imageUrl = views[0].url || views[0].Url;
      if (!imageUrl) return;

      const camera = {
        id: `NV-${cam.id || cam.Id}-${Math.random().toString(36).substr(2, 9)}`,
        name: cam.location || cam.Location || `NV Camera ${cam.id}`,
        lat: lat,
        lon: lon,
        videoUrl: null,
        imageUrl: imageUrl,
        type: 'image',
        state: 'NV',
        provider: 'NV Roads'
      };
      cameras.push(camera);
      cameraLocationMap.set(key, camera);
    });
    return cameras;
  } catch (e) { console.warn('NV Error', e); return []; }
}

// --- DFW 511 (disabled in pure web build) ---
// Your original Electron/Tauri build includes an Auth0 client_secret and uses Node's https module.
// Do NOT ship that to GitHub Pages. If you want DFW on the web, move it behind a serverless proxy
// (Cloudflare Worker / Pages Function) and call that endpoint from here.
function getDFWToken() {
  throw new Error('DFW 511 is disabled in the web build (requires server-side proxy for secrets).');
}

async function fetchDFWCameras() {
  console.warn('DFW 511 disabled in web build.');
  return [];
}

async function fetchOklahomaCameras() {
  try {
    const filter = {
      include: [
        { relation: 'mapCameras', scope: { include: 'streamDictionary' } },
        { relation: 'cameraLocationLinks', scope: { include: ['linkedCameraPole', 'cameraPole'] } }
      ]
    };
    const url = `https://oktraffic.org/api/CameraPoles?filter=${encodeURIComponent(JSON.stringify(filter))}`;
    const data = await fetchJsonWithProxy(url, { headers: {}});
    const cameras = [];
    data.forEach(pole => {
      if (pole.mapCameras?.length > 0) {
        const validViews = pole.mapCameras
          .filter(cam => cam.streamDictionary?.streamSrc && isValidUrl(cam.streamDictionary.streamSrc))
          .map(cam => ({ description: cam.location || cam.description, videoUrl: cam.streamDictionary.streamSrc }));
        if (validViews.length > 0) {
          const firstCam = pole.mapCameras[0];
          const lat = parseFloat(firstCam.latitude);
          const lon = parseFloat(firstCam.longitude);
          const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
          if (cameraLocationMap.has(key)) return;
          const camera = {
            id: `OK-${pole.id}-${Math.random().toString(36).substr(2, 9)}`,
            name: pole.description || `Camera ${pole.id}`,
            lat: lat,
            lon: lon,
            views: validViews,
            currentViewIndex: 0,
            type: 'video',
            state: 'OK',
            provider: 'ODOT'
          };
          cameras.push(camera);
          cameraLocationMap.set(key, camera);
        }
      }
    });
    return cameras;
  } catch (e) { console.warn('OK Error', e); return []; }
}

async function fetchKansasCameras() {
  try {
    const response = await fetch('https://kstg.carsprogram.org/cameras_v1/api/cameras', { headers: {}});
    if (!response.ok) throw new Error('KS API Failed');
    const data = await response.json();
    return data.filter(c => c.location?.latitude && c.location?.longitude && c.views?.[0]?.url).map(c => {
      const vidView = c.views.find(v => v.type === 'WMP');
      const imgView = c.views.find(v => v.type === 'STILL_IMAGE');
      const url = vidView ? vidView.url : (imgView ? imgView.url : c.views[0].url);
      const lat = parseFloat(c.location.latitude);
      const lon = parseFloat(c.location.longitude);
      const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
      if (cameraLocationMap.has(key)) return null;
      const camera = {
        id: `KS-${c.id}-${Math.random().toString(36).substr(2, 9)}`,
        name: c.name || 'KS Camera',
        lat: lat,
        lon: lon,
        videoUrl: vidView ? url : null,
        imageUrl: !vidView ? url : null,
        type: vidView ? 'video' : 'image',
        state: 'KS',
        provider: 'KDOT'
      };
      cameraLocationMap.set(key, camera);
      return camera;
    }).filter(c => c !== null);
  } catch (e) { console.warn('KS Error', e); return []; }
}

async function fetchIowaCameras() {
  const url = 'https://services.arcgis.com/8lRhdTsQyJpO52F1/arcgis/rest/services/Traffic_Cameras_View/FeatureServer/0/query';
  const params = new URLSearchParams({ where: '1=1', outFields: 'ImageName,ImageURL,VideoURL', returnGeometry: 'true', f: 'json', _: Date.now() });
  try {
    const response = await fetch(`${url}?${params}`, { headers: {'Accept': 'application/json' }, cache: 'no-store' });
    if (!response.ok) throw new Error(`IA HTTP ${response.status}`);
    const data = await response.json();
    if (!data?.features?.length) return [];
    return data.features.map((f, idx) => {
      const attrs = f.attributes || {};
      const geom = f.geometry || {};
      const { lat, lon } = webMercatorToLatLon(geom.x, geom.y);
      const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
      if (cameraLocationMap.has(key)) return null;
      const img = attrs.ImageURL;
      const vid = attrs.VideoURL;
      const name = attrs.ImageName || `IA Camera ${idx}`;
      if (!img && !vid) return null;
      const camera = {
        id: `IA-${idx}-${Math.random().toString(36).substr(2, 9)}`,
        name: name,
        lat: lat,
        lon: lon,
        videoUrl: vid && isValidUrl(vid) ? vid : null,
        imageUrl: img || null,
        type: vid && isValidUrl(vid) ? 'video' : 'image',
        state: 'IA',
        provider: 'IADOT'
      };
      cameraLocationMap.set(key, camera);
      return camera;
    }).filter(c => c !== null);
  } catch (e) { console.error('IA Error', e); return []; }
}

async function fetchIllinoisCameras() {
  const url = 'https://raw.githubusercontent.com/anony121221/maps-data/refs/heads/main/Illinois/Illinois.geojson';
  try {
    const res = await fetch(`${url}?v=${Date.now()}`, { headers: {}, cache: 'no-store' });
    if (!res.ok) throw new Error(`IL HTTP ${res.status}`);
    const data = await res.json();
    if (!data?.features?.length) return [];
    const locationGroups = new Map();
    data.features.forEach((f, idx) => {
      const props = f.properties || {};
      const coords = f.geometry?.coordinates || [];
      if (!coords.length || !props.SnapShot) return;
      const locationName = props.CameraLocation || `Camera ${idx}`;
      const direction = props.CameraDirection || '';
      if (!locationGroups.has(locationName)) {
        locationGroups.set(locationName, {
          id: `IL-${idx}-${Math.random().toString(36).substr(2, 9)}`,
          name: locationName,
          lat: parseFloat(coords[1]),
          lon: parseFloat(coords[0]),
          views: [],
          type: 'image',
          state: 'IL',
          provider: 'Illinois DOT'
        });
      }
      const camera = locationGroups.get(locationName);
      camera.views.push({ description: `${locationName} - ${direction}`, videoUrl: null, imageUrl: props.SnapShot });
    });
    const cameras = [];
    locationGroups.forEach(camera => {
      const key = `${camera.lat.toFixed(3)},${camera.lon.toFixed(3)}`;
      if (!cameraLocationMap.has(key) && camera.views.length > 0 && !isNaN(camera.lat) && !isNaN(camera.lon)) {
        cameras.push(camera);
        cameraLocationMap.set(key, camera);
      }
    });
    return cameras;
  } catch (e) { console.error('IL Error', e); return []; }
}

async function fetchLouisianaCameras() {
  const url = 'https://raw.githubusercontent.com/anony121221/maps-data/refs/heads/main/Louisiana/louisiana.geojson';
  try {
    const res = await fetch(`${url}?v=${Date.now()}`, { headers: {}, cache: 'no-store' });
    if (!res.ok) throw new Error(`LA HTTP ${res.status}`);
    const data = await res.json();
    if (!data?.features?.length) return [];
    const cameras = [];
    data.features.forEach((f, idx) => {
      const props = f.properties || {};
      const coords = f.geometry?.coordinates || [];
      if (!coords.length || !props.page_url) return;
      const lat = parseFloat(coords[1]);
      const lon = parseFloat(coords[0]);
      const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
      if (cameraLocationMap.has(key)) return;
      const camera = {
        id: `LA-${props.id || idx}-${Math.random().toString(36).substr(2, 9)}`,
        name: props.name || `Camera ${props.id}`,
        lat: lat,
        lon: lon,
        imageUrl: props.page_url,
        videoUrl: null,
        type: 'image',
        state: 'LA',
        provider: 'LADOTD'
      };
      cameras.push(camera);
      cameraLocationMap.set(key, camera);
    });
    return cameras;
  } catch (e) { console.error('LA Error', e); return []; }
}

async function fetchMississippiCameras() {
  const url = 'https://raw.githubusercontent.com/anony121221/maps-data/refs/heads/main/Mississippi/mississippi.geojson';
  try {
    const res = await fetch(`${url}?v=${Date.now()}`, { headers: {}, cache: 'no-store' });
    if (!res.ok) throw new Error(`MS HTTP ${res.status}`);
    const data = await res.json();
    if (!data?.features?.length) return [];
    const cameras = [];
    data.features.forEach((f, idx) => {
      const props = f.properties || {};
      const coords = f.geometry?.coordinates || [];
      if (!coords.length) return;
      const lat = parseFloat(coords[1]);
      const lon = parseFloat(coords[0]);
      const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
      if (cameraLocationMap.has(key)) return;
      
      // Use official MDOT iframe URL based on site ID
      // Example: https://mdottraffic.com/mapbubbles/camerasite.aspx?site=1
      
      const siteId = props.id;
      if (!siteId) return;
      
      const iframeUrl = `https://mdottraffic.com/mapbubbles/camerasite.aspx?site=${siteId}`;

      const camera = {
        id: `MS-${props.id || idx}-${Math.random().toString(36).substr(2, 9)}`,
        name: props.title || `Camera ${props.id}`,
        lat: lat,
        lon: lon,
        iframeUrl: iframeUrl, // Storing iframe URL
        videoUrl: null,
        imageUrl: null,
        type: 'iframe', // Explicitly setting type to iframe
        state: 'MS',
        provider: 'MDOT'
      };
      cameras.push(camera);
      cameraLocationMap.set(key, camera);
    });
    return cameras;
  } catch (e) { console.error('MS Error', e); return []; }
}

async function fetchTexasCameras() {
  const austinUrl = 'https://raw.githubusercontent.com/anony121221/maps-data/refs/heads/main/Texas/Austin.geojson';
  const houstonUrl = 'https://raw.githubusercontent.com/anony121221/maps-data/refs/heads/main/Texas/Houston.geojson';
  const cameras = [];
  try {
    const res = await fetch(`${austinUrl}?v=${Date.now()}`, { headers: {}, cache: 'no-store' });
    if (res.ok) {
      const data = await res.json();
      if (data?.features?.length) {
        data.features.forEach((f, idx) => {
          const p = f.properties;
          const c = f.geometry.coordinates;
          const link = p.screenshot_address || p.image_url || p.url;
          if (!link) return;
          const lat = parseFloat(c[1]);
          const lon = parseFloat(c[0]);
          const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
          if (cameraLocationMap.has(key)) return;
          const camera = {
            id: `TX-ATX-${idx}-${Math.random().toString(36).substr(2, 9)}`,
            name: p.kimley_horn_camera_name || p.name || 'Austin Camera',
            lat: lat,
            lon: lon,
            imageUrl: link,
            type: 'image',
            state: 'TX',
            provider: 'Austin'
          };
          cameras.push(camera);
          cameraLocationMap.set(key, camera);
        });
      }
    }
  } catch (e) { console.error('TX Austin Error', e); }
  try {
    const res = await fetch(`${houstonUrl}?v=${Date.now()}`, { headers: {}, cache: 'no-store' });
    if (res.ok) {
      const data = await res.json();
      if (data?.features?.length) {
        data.features.forEach((f, idx) => {
          const p = f.properties;
          const c = f.geometry.coordinates;
          // Check all casing variations for Houston AND handle multiple key formats
          const link = p.image || p.Image || p.url || p.Url || p.image_url || p.Image_Url;
          if (!link) return;
          const lat = parseFloat(c[1]);
          const lon = parseFloat(c[0]);
          const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
          if (cameraLocationMap.has(key)) return;
          const camera = {
            id: `TX-HOU-${idx}-${Math.random().toString(36).substr(2, 9)}`,
            name: p.name || p.location || 'Houston Camera',
            lat: lat,
            lon: lon,
            imageUrl: link,
            type: 'image',
            state: 'TX',
            provider: 'Houston TranStar'
          };
          cameras.push(camera);
          cameraLocationMap.set(key, camera);
        });
      }
    }
  } catch (e) { console.error('TX Houston Error', e); }
  return cameras;
}

async function fetchSouthDakotaCameras() {
  const url = 'https://sd.cdn.iteris-atis.com/geojson/icons/metadata/icons.cameras.geojson';
  try {
    const res = await fetch(`${url}?v=${Date.now()}`, { headers: {}, cache: 'no-store' });
    if (!res.ok) throw new Error(`SD HTTP ${res.status}`);
    const data = await res.json();
    if (!data?.features?.length) return [];
    const cameras = [];
    data.features.forEach((f, idx) => {
      const props = f.properties || {};
      const coords = f.geometry?.coordinates || [];
      if (!coords.length || !props.cameras?.length) return;
      const firstCamera = props.cameras[0];
      const imageUrl = firstCamera.image;
      if (!imageUrl) return;
      const lat = parseFloat(coords[1]);
      const lon = parseFloat(coords[0]);
      const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
      if (cameraLocationMap.has(key)) return;
      const camera = {
        id: `SD-${props.id || idx}-${Math.random().toString(36).substr(2, 9)}`,
        name: props.name || 'SD Camera',
        lat: lat,
        lon: lon,
        imageUrl: imageUrl,
        videoUrl: null,
        type: 'image',
        state: 'SD',
        provider: 'SDDOT'
      };
      cameras.push(camera);
      cameraLocationMap.set(key, camera);
    });
    return cameras;
  } catch (e) { console.error('SD Error', e); return []; }
}

async function fetchAlabamaCameras() {
  const url = 'https://api.algotraffic.com/v3.0/Cameras';
  try {
    const res = await fetch(url, { headers: {}, cache: 'no-store' });
    if (!res.ok) throw new Error(`AL HTTP ${res.status}`);
    const data = await res.json();
    if (!Array.isArray(data)) return [];
    const cameras = [];
    data.forEach(cam => {
      const loc = cam.location || {};
      if (!loc.latitude || !loc.longitude) return;
      const lat = parseFloat(loc.latitude);
      const lon = parseFloat(loc.longitude);
      const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
      if (cameraLocationMap.has(key)) return;
      const hasVideo = cam.hlsUrl && cam.hlsUrl !== '';
      const hasImage = cam.imageUrl && cam.imageUrl !== '';
      const camera = {
        id: `AL-${cam.id}-${Math.random().toString(36).substr(2, 9)}`,
        name: `${loc.displayRouteDesignator || ''} @ ${loc.displayCrossStreet || ''}`.trim() || `Camera ${cam.id}`,
        lat: lat,
        lon: lon,
        videoUrl: hasVideo ? cam.hlsUrl : null,
        imageUrl: hasImage ? cam.imageUrl : null,
        type: hasVideo ? 'video' : 'image',
        state: 'AL',
        provider: 'ALDOT'
      };
      cameras.push(camera);
      cameraLocationMap.set(key, camera);
    });
    return cameras;
  } catch (e) { console.error('AL Error', e); return []; }
}

async function fetchMissouriCameras() {
  const url = 'https://traveler.modot.org/timconfig/feed/desktop/StreamingCams2.json';
  try {
    const res = await fetch(`${url}?v=${Date.now()}`, { headers: {}, cache: 'no-store' });
    if (!res.ok) throw new Error(`MO HTTP ${res.status}`);
    const data = await res.json();
    if (!Array.isArray(data)) return [];
    const cameras = [];
    data.forEach((cam, idx) => {
      if (!cam.x || !cam.y || !cam.html) return;
      const lat = parseFloat(cam.y);
      const lon = parseFloat(cam.x);
      const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
      if (cameraLocationMap.has(key)) return;
      const camera = {
        id: `MO-${idx}-${Math.random().toString(36).substr(2, 9)}`,
        name: cam.location || `Camera ${idx}`,
        lat: lat,
        lon: lon,
        videoUrl: cam.html,
        imageUrl: null,
        type: 'video',
        state: 'MO',
        provider: 'MoDOT'
      };
      cameras.push(camera);
      cameraLocationMap.set(key, camera);
    });
    return cameras;
  } catch (e) { console.error('MO Error', e); return []; }
}

async function fetchVirginiaCameras() {
  const url = 'https://511.vdot.virginia.gov/services/map/layers/map/cams';
  try {
    const res = await fetch(`${url}?v=${Date.now()}`, { headers: {}, cache: 'no-store' });
    if (!res.ok) throw new Error(`VA HTTP ${res.status}`);
    const data = await res.json();
    if (!data?.features?.length) return [];
    const cameras = [];
    data.features.filter(f => f.properties?.active !== false).forEach((f, idx) => {
      const props = f.properties || {};
      const coords = f.geometry?.coordinates || [];
      if (!coords.length || !props.https_url) return;
      const lat = parseFloat(coords[1]);
      const lon = parseFloat(coords[0]);
      const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
      if (cameraLocationMap.has(key)) return;
      const camera = {
        id: `VA-${props.id || idx}-${Math.random().toString(36).substr(2, 9)}`,
        name: props.description || props.name || `VA Camera ${idx}`,
        lat: lat,
        lon: lon,
        videoUrl: props.https_url,
        imageUrl: props.image_url || null,
        type: 'video',
        state: 'VA',
        provider: 'VDOT'
      };
      cameras.push(camera);
      cameraLocationMap.set(key, camera);
    });
    return cameras;
  } catch (e) { console.error('VA Error', e); return []; }
}

async function fetchNewMexicoCameras() {
  const url = 'https://raw.githubusercontent.com/anony121221/maps-data/refs/heads/main/New%20Mexico/newmexico.json';
  try {
    const res = await fetch(`${url}?v=${Date.now()}`, { headers: {}, cache: 'no-store' });
    if (!res.ok) throw new Error(`NM HTTP ${res.status}`);
    const text = await res.text();
    const jsonStart = text.indexOf('(');
    const jsonEnd = text.lastIndexOf(')');
    if (jsonStart === -1 || jsonEnd === -1) return [];
    const jsonStr = text.substring(jsonStart + 1, jsonEnd);
    const data = JSON.parse(jsonStr);
    if (!data?.cameraInfo?.length) return [];
    const cameras = [];
    data.cameraInfo.forEach((cam, idx) => {
      if (!cam.lat || !cam.lon || !cam.snapshotFile) return;
      const lat = parseFloat(cam.lat);
      const lon = parseFloat(cam.lon);
      const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
      if (cameraLocationMap.has(key)) return;
      const camera = {
        id: `NM-${idx}-${Math.random().toString(36).substr(2, 9)}`,
        name: cam.title || cam.name || `Camera ${idx}`,
        lat: lat,
        lon: lon,
        videoUrl: null,
        imageUrl: cam.snapshotFile,
        type: 'image',
        state: 'NM',
        provider: 'NMDOT'
      };
      cameras.push(camera);
      cameraLocationMap.set(key, camera);
    });
    return cameras;
  } catch (e) { console.error('NM Error', e); return []; }
}

async function fetchOpenTrafficCameras() {
  const url = 'https://raw.githubusercontent.com/AidanWelch/OpenTrafficCamMap/refs/heads/master/cameras/USA.json';
  try {
    const response = await fetch(url, { headers: {}});
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    const cameras = [];
    Object.keys(data).forEach(stateKey => {
      const stateData = data[stateKey];
      const stateCode = stateMap[stateKey] || stateKey.substring(0, 2).toUpperCase();
      Object.keys(stateData).forEach(cityKey => {
        const cityCameras = stateData[cityKey];
        if (Array.isArray(cityCameras)) {
          cityCameras.forEach((cam, idx) => {
            const lat = parseFloat(cam.latitude || cam.lat);
            const lon = parseFloat(cam.longitude || cam.lon);
            const link = cam.url;
            if (lat && lon && link) {
              const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
              if (cameraLocationMap.has(key)) return;
              const isVideo = cam.format === 'M3U8' || link.endsWith('.m3u8');
              const camera = {
                id: `OTC-${stateCode}-${cityKey}-${idx}-${Math.random().toString(36).substr(2, 9)}`,
                name: cam.description || cam.name || `${cityKey} Camera`,
                lat: lat,
                lon: lon,
                videoUrl: isVideo ? link : null,
                imageUrl: !isVideo ? link : null,
                type: isVideo ? 'video' : 'image',
                state: stateCode,
                provider: 'OpenTrafficCam'
              };
              cameras.push(camera);
              cameraLocationMap.set(key, camera);
            }
          });
        }
      });
    });
    return cameras;
  } catch (error) { console.error('OpenTrafficCam Error', error); return []; }
}

async function fetchMinnesotaCameras() {
  const url = 'https://raw.githubusercontent.com/anony121221/maps-data/refs/heads/main/Minnesota/mn.geojson';
  try {
    const res = await fetch(`${url}?v=${Date.now()}`, { headers: {}, cache: 'no-store' });
    if (!res.ok) throw new Error(`MN HTTP ${res.status}`);
    const data = await res.json();
    if (!data?.features?.length) return [];

    const cameras = [];
    data.features.forEach((f, idx) => {
      const p = f.properties || {};
      const c = f.geometry?.coordinates;
      if (!c || c.length < 2) return;

      const lat = parseFloat(c[1]);
      const lon = parseFloat(c[0]);
      if (isNaN(lat) || isNaN(lon)) return;

      const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
      if (cameraLocationMap.has(key)) return;

      const imageUrl = p.jpg;
      const videoUrl = isValidUrl(p.m3u8) ? p.m3u8 : null;

      if (!imageUrl && !videoUrl) return;

      const hasVideo = !!videoUrl;
      const camera = {
        id: `MN-${p.camera_id || idx}-${Math.random().toString(36).substr(2, 9)}`,
        name: p.title || `MN Camera ${idx}`,
        lat,
        lon,
        imageUrl,
        videoUrl,
        type: hasVideo ? 'video' : 'image',
        displayMode: hasVideo ? 'video' : 'image',
        state: 'MN',
        provider: 'MnDOT'
      };

      cameras.push(camera);
      cameraLocationMap.set(key, camera);
    });

    return cameras;
  } catch (e) { console.error('MN Error', e); return []; }
}

// CORE APP LOGIC

function clearMarkers() {
  markerClusterGroup.clearLayers();
}

function addCameraMarkers(cameras) {
  clearMarkers();
  
  const markers = cameras.map(camera => {
    if (!camera.lat || !camera.lon || isNaN(camera.lat) || isNaN(camera.lon)) return null;

    const marker = L.marker([camera.lat, camera.lon], {
      icon: L.divIcon({
        className: 'camera-marker',
        iconSize: [14, 14],
        iconAnchor: [7, 7]
      })
    });

    const typeEmoji = camera.type === 'video' ? '📺' : (camera.type === 'iframe' ? '🌐' : '📷');
    const typeText = camera.type === 'video' ? 'Video Feed' : (camera.type === 'iframe' ? 'Live Viewer' : 'Snapshot (Auto-refresh)');
    
    const popupHTML = `
      <div class="camera-popup-wrapper">
        <h4 class="popup-title">${camera.name}</h4>
        <div class="popup-meta">
          <span class="provider">${camera.provider}</span> • <span class="state">${camera.state}</span>
        </div>
        <div class="popup-type">
          ${typeEmoji} ${typeText}
        </div>
        <button class="popup-button" data-camera-id="${camera.id}">View Camera →</button>
      </div>
    `;

    marker.bindPopup(popupHTML, {
      className: 'custom-camera-popup',
      maxWidth: 280,
      closeButton: true,
      autoClose: true
    });

    // Wire the popup button without relying on inline handlers (more reliable in WebView).
    marker.on('popupopen', (e) => {
      const popupEl = e.popup && e.popup.getElement ? e.popup.getElement() : null;
      if (!popupEl) return;
      const btn = popupEl.querySelector('.popup-button');
      if (!btn) return;
      btn.onclick = (evt) => {
        if (evt && evt.preventDefault) evt.preventDefault();
        if (evt && evt.stopPropagation) evt.stopPropagation();
        showViewer(camera);
      };
    });
    
    return marker;
  }).filter(m => m !== null);

  markerClusterGroup.addLayers(markers);
}

function updateCameraList(cameras) {
  const list = document.getElementById('camera-list');
  list.innerHTML = '';
  const displayLimit = cameras.length > 500 ? 100 : cameras.length;
  for (let i = 0; i < displayLimit; i++) {
    const camera = cameras[i];
    const item = document.createElement('div');
    item.className = 'camera-item';
    if (camera.id === selectedCameraId) item.classList.add('active');
    item.innerHTML = `
      <div class="camera-name">
        <span class="camera-status" style="background:${camera.type==='video'?'#4ade80':(camera.type === 'iframe' ? '#60a5fa' : '#fbbf24')}"></span>
        ${camera.name}
      </div>
      <div class="camera-meta">${camera.state} • ${camera.provider}</div>
    `;
    item.onclick = () => showViewer(camera);
    list.appendChild(item);
  }
}

function filterCameras(searchTerm, stateFilter) {
  filteredCameras = allCameras.filter(camera => {
    const term = searchTerm.toLowerCase();
    const matchName = camera.name?.toLowerCase().includes(term);
    let matchState = stateFilter === 'all' || camera.state === stateFilter;
    if (stateFilter === 'OTM') {
      matchState = camera.provider === 'OpenTrafficCam';
    }
    return matchName && matchState;
  });
  
  addCameraMarkers(filteredCameras);
  updateCameraList(filteredCameras);
  document.getElementById('showing-count').textContent = filteredCameras.length;
}

// VIEWER LOGIC

async function showViewer(camera) {
  selectedCameraId = camera.id;
  const viewer = document.getElementById('viewer');
  const title = document.getElementById('viewer-title');
  const content = document.getElementById('viewer-content');
  viewer.classList.remove('hidden');

  if (!camera.displayMode) {
    camera.displayMode = camera.type === 'video' ? 'video' : 'image';
  }
  
  destroyCurrentVideo();
  if (imageRefreshInterval) {
    clearInterval(imageRefreshInterval);
    imageRefreshInterval = null;
  }
  
  content.innerHTML = '';
  
  // IFRAME HANDLER (FOR MISSISSIPPI)
  if (camera.type === 'iframe' && camera.iframeUrl) {
      title.innerHTML = `<span>${camera.name}</span>`;
      const iframe = document.createElement('iframe');
      iframe.src = camera.iframeUrl;
      iframe.style.width = '100%';
      iframe.style.height = '400px';
      iframe.style.border = 'none';
      content.appendChild(iframe);
      
      map.panTo([camera.lat, camera.lon]);
      return; // Exit early since we are using iframe
  }

  if (camera.views && camera.views.length > 0) {
    const currentIndex = camera.currentViewIndex || 0;
    const currentView = camera.views[currentIndex];
    if (!currentView || brokenVideoUrls.has(currentView.videoUrl)) {
      let validIndex = 0;
      for (let i = 0; i < camera.views.length; i++) {
        if (!brokenVideoUrls.has(camera.views[i].videoUrl)) {
          validIndex = i;
          break;
        }
      }
      camera.currentViewIndex = validIndex;
    }
  }

  let videoUrl = null;
  let imageUrl = null;

  if (camera.views && camera.views.length > 0) {
    const idx = camera.currentViewIndex || 0;
    videoUrl = camera.views[idx]?.videoUrl;
    imageUrl = camera.views[idx]?.imageUrl;
  } else {
    videoUrl = camera.videoUrl;
    imageUrl = camera.imageUrl;
  }

  if (videoUrl && isHlsUrl(videoUrl)) {
    const proxy = await getProxyBaseUrl();
    if (proxy) {
      videoUrl = `${proxy}${encodeURIComponent(videoUrl)}`;
    }
  }

  const supportsVideo = !!videoUrl && !brokenVideoUrls.has(videoUrl);
  const supportsImage = !!imageUrl;

  if (!camera.displayMode) {
    camera.displayMode = supportsVideo ? 'video' : 'image';
  }

  const isFullscreen = document.fullscreenElement === viewer;

  let headerHtml = `<div class="viewer-header-row"><span class="viewer-title-text">${camera.name}</span><div class="viewer-controls">`;

  if (supportsVideo && supportsImage) {
    const isVideoMode = camera.displayMode === 'video';
    headerHtml += `
      <button class="viewer-control-button ${isVideoMode ? 'active' : ''}" onclick="window.setCameraMode('${camera.id}', 'video')">Video</button>
      <button class="viewer-control-button ${!isVideoMode ? 'active' : ''}" onclick="window.setCameraMode('${camera.id}', 'image')">Image</button>
    `;
  }

  headerHtml += `<button id="viewer-fullscreen-btn" class="viewer-control-button" onclick="window.toggleViewerFullscreen()">${isFullscreen ? 'Exit Fullscreen' : 'Fullscreen'}</button>`;
  headerHtml += `</div></div>`;

  if (camera.views && camera.views.length > 1) {
    const validViews = camera.views.filter((v, idx) => !brokenVideoUrls.has(v.videoUrl));
    if (validViews.length > 1) {
      headerHtml += `<div style="margin-top:5px; display:flex; gap:5px; flex-wrap:wrap;">`;
      camera.views.forEach((v, originalIndex) => {
        if (!brokenVideoUrls.has(v.videoUrl)) {
          const isActive = originalIndex === (camera.currentViewIndex || 0);
          headerHtml += `
            <button
              onclick="window.switchCameraView('${camera.id}', ${originalIndex})"
              style="padding:4px 8px; border:none; border-radius:3px; font-size:11px; cursor:pointer; background:${isActive?'#4a9eff':'#333'}; color:${isActive?'white':'#888'};">
              View ${originalIndex + 1}
            </button>
          `;
        }
      });
      headerHtml += `</div>`;
    }
  }
  title.innerHTML = headerHtml;

  // FIXED: Logic to fallback to image if video fails or is blocked
  const showFallbackImage = () => {
    if (imageRefreshInterval) clearInterval(imageRefreshInterval);
    content.innerHTML = '';
    
    // Check if we have a valid image URL to show
    if (imageUrl) {
        const img = document.createElement('img');
        img.style.width = '100%';
        img.style.height = 'auto';
        img.style.display = 'block';
        img.alt = "Traffic Camera Feed"; // Accessibility improvement
        
        // Anti-caching timestamp logic
        const updateImage = () => {
          const separator = imageUrl.includes('?') ? '&' : '?';
          img.src = `${imageUrl}${separator}t=${Date.now()}`;
        };
        
        // Initial load
        updateImage();
        content.appendChild(img);
        
        // Add error handler for the image itself (e.g. if MDOT image fails)
        img.onerror = () => {
            console.warn("Image load failed:", imageUrl);
            // Optionally try to remove the image or show text
            // content.innerHTML = '<div style="padding:20px; text-align:center; color:#fff;">Image currently unavailable</div>';
        };
        
        // Refresh every 3 seconds
        imageRefreshInterval = setInterval(updateImage, 3000);
        
        const info = document.createElement('div');
        info.style.padding = '8px';
        info.style.fontSize = '12px';
        info.style.color = '#888';
        info.style.textAlign = 'center';
        info.innerHTML = 'Live View (Refreshes every 3s)';
        content.appendChild(info);
    } else {
        content.innerHTML = '<div style="padding:20px; text-align:center; color:#fff;">No visual available</div>';
    }
  };

  const preferredMode = camera.displayMode === 'video' && supportsVideo ? 'video' : (supportsImage ? 'image' : 'video');

  if (preferredMode === 'video' && videoUrl && !brokenVideoUrls.has(videoUrl)) {
    const vid = document.createElement('video');
    vid.id = 'camera-player';
    vid.controls = true;
    vid.autoplay = true;
    vid.muted = true;
    vid.playsInline = true;
    vid.style.width = '100%';
    vid.style.height = '400px';
    content.appendChild(vid);

    if (isHlsUrl(videoUrl) && window.Hls && window.Hls.isSupported && window.Hls.isSupported()) {
      try {
        currentHls = new window.Hls({
          maxBufferLength: 30,
          maxMaxBufferLength: 60,
          enableWorker: true
        });
        currentHls.loadSource(videoUrl);
        currentHls.attachMedia(vid);
        currentHls.on(window.Hls.Events.ERROR, (_, data) => {
          if (data && data.fatal) {
            console.warn('HLS fatal error, falling back to image', data);
            brokenVideoUrls.add(videoUrl);
            showFallbackImage();
          }
        });
      } catch (e) {
        console.error('HLS init failed', e);
        showFallbackImage();
      }
    } else if (vid.canPlayType('application/vnd.apple.mpegurl')) {
      vid.src = videoUrl;
      vid.play().catch(() => {});
    } else {
      // Non-HLS video (or HLS not supported): use Video.js if available.
      if (window.videojs) {
        vid.className = 'video-js vjs-default-skin';
        setTimeout(() => {
          try {
            currentPlayer = videojs('camera-player', {
              sources: [{ src: videoUrl, type: 'application/x-mpegURL' }],
              fluid: true
            });
            currentPlayer.on('error', () => {
              console.warn('Video failed, falling back to image');
              brokenVideoUrls.add(videoUrl);
              showFallbackImage();
            });
            const playPromise = currentPlayer.play();
            if (playPromise !== undefined) {
              playPromise.catch(() => {
                currentPlayer.muted(true);
                const retry = currentPlayer.play();
                if (retry && retry.catch) retry.catch(() => showFallbackImage());
              });
            }
          } catch (e) {
            console.error('Player init failed', e);
            showFallbackImage();
          }
        }, 50);
      } else {
        showFallbackImage();
      }
    }

  } else if (imageUrl) {
    showFallbackImage();
  } else {
    content.innerHTML = '<div style="padding:20px; text-align:center; color:#fff;">No valid stream or image available</div>';
  }
  map.panTo([camera.lat, camera.lon]);
}

window.showCamera = (id) => {
  const c = allCameras.find(cam => cam.id === id);
  if (c) showViewer(c);
};

window.switchCameraView = (id, idx) => {
  const c = allCameras.find(cam => cam.id === id);
  if (c) {
    c.currentViewIndex = idx;
    showViewer(c);
  }
};

window.setCameraMode = (id, mode) => {
  const c = allCameras.find(cam => cam.id === id);
  if (c) {
    c.displayMode = mode;
    showViewer(c);
  }
};

window.toggleViewerFullscreen = () => {
  const viewer = document.getElementById('viewer');
  if (!viewer) return;
  if (document.fullscreenElement === viewer) {
    document.exitFullscreen().catch(() => {});
  } else {
    viewer.requestFullscreen().catch(() => {});
  }
};

document.addEventListener('fullscreenchange', () => {
  const btn = document.getElementById('viewer-fullscreen-btn');
  if (btn) {
    btn.textContent = document.fullscreenElement ? 'Exit Fullscreen' : 'Fullscreen';
  }
});

document.getElementById('close-viewer').onclick = () => {
  document.getElementById('viewer').classList.add('hidden');
  if (document.fullscreenElement === document.getElementById('viewer')) {
    document.exitFullscreen().catch(() => {});
  }
  destroyCurrentVideo();
  if (imageRefreshInterval) {
    clearInterval(imageRefreshInterval);
    imageRefreshInterval = null;
  }
  selectedCameraId = null;
};

// INITIALIZATION
async function loadAllCameras() {
  console.log('Loading all cameras...');
  cameraLocationMap.clear();
  
  // Named map for clearer logging
  const sources = {
    "Connecticut": fetchConnecticutCameras(),
    "Florida": fetchFloridaCameras(),
    "Idaho": fetchIdahoCameras(),
    "Maine": fetchMaineCameras(),
    "Massachusetts": fetchMassachusettsCameras(),
    "Montana": fetchMontanaCameras(),
    "New Hampshire": fetchNewHampshireCameras(),
    "New York": fetchNewYorkCameras(),
    "Oregon": fetchOregonCameras(),
    "Pennsylvania": fetchPennsylvaniaCameras(),
    "Rhode Island": fetchRhodeIslandCameras(),
    "Vermont": fetchVermontCameras(),
    "Washington": fetchWashingtonCameras(),
    "Oklahoma": fetchOklahomaCameras(),
    "Kansas": fetchKansasCameras(),
    "Iowa": fetchIowaCameras(),
    "Illinois": fetchIllinoisCameras(),
    "Louisiana": fetchLouisianaCameras(),
    "Mississippi": fetchMississippiCameras(),
    "Texas": fetchTexasCameras(),
    "South Dakota": fetchSouthDakotaCameras(),
    "Alabama": fetchAlabamaCameras(),
    "Missouri": fetchMissouriCameras(),
    "Virginia": fetchVirginiaCameras(),
    "New Mexico": fetchNewMexicoCameras(),
    "Utah": fetchUtahCameras(),
    "Nevada": fetchNevadaCameras(),
    "North Carolina": fetchNorthCarolinaCameras(),
    "South Carolina": fetchSouthCarolinaCameras(),
    "Tennessee": fetchTennesseeCameras(),
    "Nebraska": fetchNebraskaCameras(),
    "Minnesota": fetchMinnesotaCameras(),
    "OpenTrafficCam": fetchOpenTrafficCameras()
  };

  const promises = Object.values(sources);
  const keys = Object.keys(sources);
  
  const results = await Promise.allSettled(promises);
  allCameras = [];
  
  console.group('Camera Source Status');
  results.forEach((res, index) => {
    const sourceName = keys[index];
    if (res.status === 'fulfilled') {
      const count = res.value.length;
      console.log(`✅ ${sourceName}: ${count} cameras`);
      allCameras = [...allCameras, ...res.value];
    } else {
      console.error(`❌ ${sourceName} Failed:`, res.reason);
    }
  });
  console.groupEnd();

  console.log(`Loaded ${allCameras.length} total cameras.`);
  document.getElementById('total-count').textContent = allCameras.length;
  document.getElementById('cameras-count').textContent = allCameras.length;
  
  const searchTerm = document.getElementById('search-input').value;
  const stateFilter = document.getElementById('state-filter').value;
  filterCameras(searchTerm, stateFilter);
}

// City Search using MapTiler Geocoding API
let citySearchTimeout = null;

async function searchCity(query) {
  if (!query || query.length < 2) return [];
  try {
    // Use MapTiler geocoding API (we already have a key)
    const url = `https://api.maptiler.com/geocoding/${encodeURIComponent(query)}.json?key=${MAPTILER_KEY}&country=us&types=place,locality,municipality&limit=6`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = await res.json();
    // Convert MapTiler format to match our display format
    return (data.features || []).map(f => ({
      display_name: f.place_name || f.text,
      lat: f.center[1],
      lon: f.center[0],
      context: f.context || []
    }));
  } catch (e) {
    console.error('City search error:', e);
    return [];
  }
}

function displayCityResults(results) {
  const container = document.getElementById('city-search-results');
  container.innerHTML = '';
  
  if (results.length === 0) {
    container.classList.add('hidden');
    return;
  }
  
  results.forEach(place => {
    const item = document.createElement('div');
    item.className = 'city-result-item';
    const nameParts = place.display_name.split(',');
    const name = nameParts[0].trim();
    // Extract state abbreviation from address
    const addressParts = place.display_name.split(',').map(p => p.trim());
    let stateAbbr = '';
    // Look for state - typically second to last or has format like "Texas" or "TX"
    for (let i = addressParts.length - 1; i >= 0; i--) {
      const part = addressParts[i].trim();
      // Check if it's a US state name and convert to abbreviation
      if (stateMap[part]) {
        stateAbbr = stateMap[part];
        break;
      }
      // Check if already an abbreviation (2 letters)
      if (part.length === 2 && /^[A-Z]{2}$/.test(part)) {
        stateAbbr = part;
        break;
      }
    }
    item.innerHTML = `
      <span class="city-result-name">${name}</span>
      <span class="city-result-state">${stateAbbr}</span>
    `;
    item.onclick = () => {
      const lat = parseFloat(place.lat);
      const lon = parseFloat(place.lon);
      map.flyTo([lat, lon], 12, { duration: 1.5 });
      container.classList.add('hidden');
      document.getElementById('city-search-input').value = '';
      document.getElementById('city-search-input').classList.add('hidden');
    };
    container.appendChild(item);
  });
  
  container.classList.remove('hidden');
}

function initCitySearch() {
  const btn = document.getElementById('city-search-btn');
  const input = document.getElementById('city-search-input');
  const results = document.getElementById('city-search-results');
  
  btn.onclick = () => {
    input.classList.toggle('hidden');
    if (!input.classList.contains('hidden')) {
      input.focus();
    } else {
      results.classList.add('hidden');
    }
  };
  
  input.addEventListener('input', (e) => {
    clearTimeout(citySearchTimeout);
    const query = e.target.value.trim();
    if (query.length < 2) {
      results.classList.add('hidden');
      return;
    }
    citySearchTimeout = setTimeout(async () => {
      const places = await searchCity(query);
      displayCityResults(places);
    }, 300);
  });
  
  // Close results when clicking outside
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#city-search-container')) {
      results.classList.add('hidden');
    }
  });
}

document.addEventListener('DOMContentLoaded', () => {
  initMap();
  
  // Initialize draggable viewer
  makeDraggable(document.getElementById('viewer'), document.getElementById('viewer-title'));
  
  // Initialize city search
  initCitySearch();
  
  loadAllCameras();
  
  // ONLY MRMS toggle now
  document.getElementById('mrms-toggle').addEventListener('change', (e) => toggleMRMS(e.target.checked));
  
  document.getElementById('alerts-toggle').addEventListener('change', (e) => toggleAlerts(e.target.checked));

  document.getElementById('search-input').addEventListener('input', (e) => {
    filterCameras(e.target.value, document.getElementById('state-filter').value);
  });
  document.getElementById('state-filter').addEventListener('change', (e) => {
    filterCameras(document.getElementById('search-input').value, e.target.value);
  });
  
  // Only camera refresh interval (no warnings)
  setInterval(loadAllCameras, REFRESH_INTERVAL);
});
