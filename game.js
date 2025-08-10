// --- GLOBAL VARIABLES ---
const canvas = document.getElementById("radar-scope");
const ctx = canvas.getContext("2d"); // The drawing tool for the canvas
const uiPanel = document.getElementById("ui-panel");
const headingInput = document.getElementById("heading-input");
const speedInput = document.getElementById("speed-input");
const altitudeInput = document.getElementById("altitude-input");

// --- GEOGRAPHICAL SETUP ---
// CORRECTED: Changed 69" to 09" as there can only be 60 seconds/minutes.
const topLeftCoord = "45°53'51.0\"N, 008°36'35.0\"E"; 
const bottomRightCoord = "45°05'08.0\"N, 009°36'50.0\"E";

/**
 * Parses a DMS (Degrees, Minutes, Seconds) string into decimal degrees.
 * @param {string} dmsStr - The DMS string to parse.
 * @returns {{lat: number, lon: number}}
 */
function parseDMS(dmsStr) {
  const parts = dmsStr.split(/[^\d\w\.]+/);
  const latDeg = parseFloat(parts[0]);
  const latMin = parseFloat(parts[1]);
  const latSec = parseFloat(parts[2]);
  const latDir = parts[3];
  const lonDeg = parseFloat(parts[4]);
  const lonMin = parseFloat(parts[5]);
  const lonSec = parseFloat(parts[6]);
  const lonDir = parts[7];

  let lat = latDeg + latMin / 60 + latSec / 3600;
  if (latDir === 'S') {
    lat = -lat;
  }

  let lon = lonDeg + lonMin / 60 + lonSec / 3600;
  if (lonDir === 'W') {
    lon = -lon;
  }
  return { lat, lon };
}

/**
 * Calculates the distance between two coordinates using the Haversine formula.
 * @param {object} coords1 - The first coordinate {lat, lon}.
 * @param {object} coords2 - The second coordinate {lat, lon}.
 * @returns {number} - The distance in kilometers.
 */
function haversineDistance(coords1, coords2) {
    const R = 6371; // Radius of the Earth in km
    const dLat = (coords2.lat - coords1.lat) * Math.PI / 180;
    const dLon = (coords2.lon - coords1.lon) * Math.PI / 180;
    const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(coords1.lat * Math.PI / 180) * Math.cos(coords2.lat * Math.PI / 180) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    const distance = R * c;
    return distance;
}

const topLeft = parseDMS(topLeftCoord);
const bottomRight = parseDMS(bottomRightCoord);

const radarWidthKm = haversineDistance({ lat: topLeft.lat, lon: topLeft.lon }, { lat: topLeft.lat, lon: bottomRight.lon });
const radarHeightKm = haversineDistance({ lat: topLeft.lat, lon: topLeft.lon }, { lat: bottomRight.lat, lon: topLeft.lon });

const minLon = Math.min(topLeft.lon, bottomRight.lon);
const maxLon = Math.max(topLeft.lon, bottomRight.lon);
const minLat = Math.min(topLeft.lat, bottomRight.lat);
const maxLat = Math.max(topLeft.lat, bottomRight.lat);


// --- GAME CONSTANTS ---
const RADAR_RANGE_KM = Math.max(radarWidthKm, radarHeightKm);
const SWEEP_INTERVAL_MS = 2000;
const KNOTS_TO_KPS = 0.000514444;

// --- Settings ---
canvas.addEventListener("contextmenu", (e) => {
  e.preventDefault();
});

// --- GAME STATE ---
let aircraftList = [];
let navDataPoints = []; 
let selectedAircraft = null;
let radarRadius;
let kmPerPixel;

// --- TIMING & ANIMATION STATE ---
let lastUpdateTime = 0;
let timeSinceLastSweep = 0;
let displayedAircraft = [];

// --- CLASSES FOR GAME OBJECTS ---

class Aircraft {
  constructor(callsign, x, y, heading, altitude, speed, tagAngle) {
    this.callsign = callsign;
    this.x = x;
    this.y = y;
    this.heading = heading, this.targetHdg = heading;
    this.altitude = altitude, this.targetAlt = altitude;
    this.speed = speed, this.targetSpd = speed;
    this.tagAngle = tagAngle || 0;
  }

  update(deltaTime) {
    if (!kmPerPixel) return;
    const speedInKps = this.speed * KNOTS_TO_KPS;
    const distanceMovedKm = speedInKps * deltaTime;
    const distanceMovedPx = distanceMovedKm / kmPerPixel;
    const rad = this.heading * Math.PI / 180;
    this.x += Math.sin(rad) * distanceMovedPx;
    this.y -= Math.cos(rad) * distanceMovedPx;
  }

  draw() {
    ctx.beginPath();
    ctx.arc(this.x, this.y, 4, 0, 2 * Math.PI);
    ctx.globalAlpha = 1;
    ctx.fillStyle = "#0f0";
    ctx.fill();
    ctx.globalAlpha = 1;

    const lineTimeLength = 60;
    const speedInKps = this.speed * KNOTS_TO_KPS;
    const distanceKm = speedInKps * lineTimeLength;
    const lineLength = distanceKm / kmPerPixel;
    const rad = (this.heading * Math.PI) / 180;
    const endX = this.x + Math.sin(rad) * lineLength;
    const endY = this.y - Math.cos(rad) * lineLength;
    ctx.beginPath();
    ctx.moveTo(this.x, this.y);
    ctx.lineTo(endX, endY);
    ctx.strokeStyle = "#0f0";
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.font = '12px "Courier New"';
    const tagRadius = 40;
    const tagX = this.x + tagRadius * Math.cos(this.tagAngle);
    const tagY = this.y + tagRadius * Math.sin(this.tagAngle);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(this.callsign, tagX, tagY - 8);
    ctx.fillText(`${Math.round(this.altitude)}  ${Math.round(this.speed)}`, tagX, tagY + 8);
  }

  setHeading(newHeading) {
    if (this._headingInterval) clearInterval(this._headingInterval);
    const normalize = h => ((h % 360) + 360) % 360;
    const current = normalize(this.heading);
    this.targetHdg = normalize(newHeading);
    let diff = this.targetHdg - current;
    if (diff > 180) diff -= 360;
    if (diff < -180) diff += 360;
    const turnRate = 2;
    const intervalMs = 30;
    const step = turnRate * (intervalMs / 1000) * Math.sign(diff);
    this._headingInterval = setInterval(() => {
      let cur = normalize(this.heading);
      let d = this.targetHdg - cur;
      if (d > 180) d -= 360;
      if (d < -180) d += 360;
      if (Math.abs(d) <= Math.abs(step)) {
        this.heading = this.targetHdg;
        clearInterval(this._headingInterval);
        this._headingInterval = null;
      } else {
        this.heading = normalize(cur + step);
      }
    }, intervalMs);
  }

  setSpeed(newSpeed) {
    if (this._speedInterval) clearInterval(this._speedInterval);
    this.targetSpd = newSpeed;
    const initialSpeed = this.speed;
    const duration = Math.abs(newSpeed - this.speed) * 200;
    const startTime = Date.now();
    this._speedInterval = setInterval(() => {
      const elapsed = Date.now() - startTime;
      const t = Math.min(elapsed / duration, 1);
      const smoothT = t * t * (3 - 2 * t);
      this.speed = initialSpeed + (newSpeed - initialSpeed) * smoothT;
      if (t >= 1 || Math.abs(this.speed - newSpeed) < 0.5) {
        this.speed = newSpeed;
        clearInterval(this._speedInterval);
        this._speedInterval = null;
      }
    }, 30);
  }

  setAltitude(newAltitude) {
    if (this._altitudeInterval) clearInterval(this._altitudeInterval);
    this.targetAlt = newAltitude;
    const initialAltitude = this.altitude;
    const duration = Math.abs(newAltitude - this.altitude) * 600;
    const startTime = Date.now();
    this._altitudeInterval = setInterval(() => {
      const elapsed = Date.now() - startTime;
      const t = Math.min(elapsed / duration, 1);
      const smoothT = t * t * (3 - 2 * t);
      this.altitude = initialAltitude + (newAltitude - initialAltitude) * smoothT;
      if (t >= 1 || Math.abs(this.altitude - newAltitude) < 1) {
        this.altitude = newAltitude;
        clearInterval(this._altitudeInterval);
        this._altitudeInterval = null;
      }
    }, 30);
  }
}

// --- CORE FUNCTIONS ---

function resizeCanvas() {
  const padding = 20;
  const gap = 10;
  const availableWidth = window.innerWidth - uiPanel.offsetWidth - padding - gap;
  const availableHeight = window.innerHeight - padding;
  const size = Math.min(availableWidth, availableHeight);
  canvas.width = size;
  canvas.height = size;
  radarRadius = canvas.width / 2;
  kmPerPixel = RADAR_RANGE_KM / size;
}

function drawVorSymbol(ctx, x, y, size) {
  // --- Draw the Hexagon Outline ---
  ctx.beginPath();
  // Move to the first vertex (top point)
  ctx.moveTo(x + size * Math.cos(0), y + size * Math.sin(0));

  // Loop to draw the other 5 vertices
  for (let i = 1; i <= 6; i++) {
    const angle = i * Math.PI / 3; // 60 degrees in radians for each step
    ctx.lineTo(x + size * Math.cos(angle), y + size * Math.sin(angle));
  }
  
  ctx.strokeStyle = "rgba(0, 255, 0, 0.7)";
  ctx.lineWidth = 1.5;
  ctx.stroke(); // Draw the outline

  // --- Draw the Center Dot ---
  ctx.beginPath();
  ctx.arc(x, y, 1.5, 0, 2 * Math.PI); // A small 1.5px radius dot
  ctx.fillStyle = "rgba(0, 255, 0, 0.7)";
  ctx.fill(); // Fill the dot
  // Next, draw the enclosing square for the DME component.
  // We make the box slightly larger than the hexagon for a nice visual margin.
  const boxSize = size * 2;
  ctx.strokeStyle = "rgba(0, 255, 0, 0.7)";
  ctx.lineWidth = 1.5;
  ctx.strokeRect(x - boxSize / 2, y - boxSize / 2, boxSize, boxSize);
}

function drawNavData() {
  if (navDataPoints.length === 0) return;

  ctx.fillStyle = "rgba(0, 255, 0, 0.7)";
  ctx.strokeStyle = "rgba(0, 255, 0, 0.7)";
  ctx.font = '11px "Courier New"';
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";

  navDataPoints.forEach(point => {
    const x = ((point.lon - minLon) / (maxLon - minLon)) * canvas.width;
    const y = ((maxLat - point.lat) / (maxLat - minLat)) * canvas.height;

    if (point.type === 'WN') {
      ctx.beginPath();
      ctx.moveTo(x, y - 3.75); // Top point (25% smaller)
      ctx.lineTo(x - 3, y + 2.25); // Bottom left
      ctx.lineTo(x + 3, y + 2.25); // Bottom right
      ctx.closePath();
      ctx.fill();
    } else if (point.type === 'V') {
      drawVorSymbol(ctx, x, y, 5);
    }

    // Only display name if it does NOT contain a number
    if (!/\d/.test(point.name)) {
      ctx.fillText(point.name, x + 8, y);
    }
  });
}

function gameLoop(currentTime) {
  if (lastUpdateTime === 0) {
    lastUpdateTime = currentTime;
  }
  const deltaTimeMs = currentTime - lastUpdateTime;
  lastUpdateTime = currentTime;

  aircraftList.forEach(plane => plane.update(deltaTimeMs / 1000));

  timeSinceLastSweep += deltaTimeMs;
  if (timeSinceLastSweep >= SWEEP_INTERVAL_MS) {
    displayedAircraft = aircraftList.map(p => Object.assign(new Aircraft(), p));
    timeSinceLastSweep -= SWEEP_INTERVAL_MS;
  }

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  drawNavData();
  displayedAircraft.forEach(plane => plane.draw());

  requestAnimationFrame(gameLoop);
}

// --- NAV DATA LOADING ---
function loadNavData() {
  const wasmPath = 'node_modules/sql.js/dist/sql-wasm.wasm';
  const dbPath = 'NavData/NavData.sqlite';

  initSqlJs({ locateFile: () => wasmPath })
    .then(function(SQL) {
      console.log("sql.js engine initialized successfully.");
      return fetch(dbPath)
        .then(response => {
          if (!response.ok) {
            throw new Error(`Failed to fetch database: ${response.statusText}`);
          }
          return response.arrayBuffer();
        })
        .then(filebuffer => {
          console.log("Database file fetched successfully.");
          const dbObject = new SQL.Database(new Uint8Array(filebuffer));
          console.log("Database loaded into memory.");

          const query = `
            SELECT * FROM waypoint 
            WHERE 
              (type = 'WN' OR type = 'V') 
              AND lonx BETWEEN ${minLon} AND ${maxLon}
              AND laty BETWEEN ${minLat} AND ${maxLat}
              AND ident NOT LIKE 'VP%'
              AND (airport_id IS NULL OR airport_id = '10496')
          `;
          const result = dbObject.exec(query);

          if (result.length > 0 && result[0].values.length > 0) {
            navDataPoints = result[0].values.map(row => {
              return { 
                name: row[3], // ident column
                type: row[9], // type column
                lon:  row[14], // lonx column
                lat:  row[15] // laty column
              };
            });
            console.log("Loaded waypoints and VORs");
          } else {
            console.log("No waypoints found for the selected region.");
          }

          // Load Airport data
          const airportQuery = `
            SELECT * FROM airport 
            WHERE
              lonx BETWEEN ${minLon} AND ${maxLon}
              AND laty BETWEEN ${minLat} AND ${maxLat}
          `;
          const airportResult = dbObject.exec(airportQuery);
          if (airportResult.length > 0 && airportResult[0].values.length > 0) {
            const airports = airportResult[0].values.map(row => {
              return {
                id: row[0], // airport_id column
                icao: row[2], // icao column  
                name: row[7], // Name column
                TA: row[65], // type column
                lon:  row[68], // lonx column
                lat:  row[69] // laty column
              };
            });
            console.log("Loaded airports:", airports);
          } else {
            console.log("No airports found for the selected region.");
          }

          dbObject.close();
        });
    })
    .catch(err => {
      console.error("A critical error occurred during nav data loading:", err);
    });
}

// --- EVENT LISTENERS ---
window.addEventListener("resize", resizeCanvas);

canvas.addEventListener("click", (e) => {
  const rect = canvas.getBoundingClientRect();
  const mouseX = e.clientX - rect.left;
  const mouseY = e.clientY - rect.top;
  aircraftList.forEach((plane) => {
    const dx = plane.x - mouseX;
    const dy = plane.y - mouseY;
    if (Math.sqrt(dx * dx + dy * dy) < 10) {
      selectedAircraft = plane;
      document.getElementById("selected-aircraft-info").innerHTML = `<p>${plane.callsign}</p>`;
      headingInput.value = plane.targetHdg;
      speedInput.value = plane.targetSpd;
      altitudeInput.value = plane.targetAlt;
    }
  });
});

canvas.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  const rect = canvas.getBoundingClientRect();
  const mouseX = e.clientX - rect.left;
  const mouseY = e.clientY - rect.top;
  aircraftList.forEach((plane) => {
    const dx = plane.x - mouseX;
    const dy = plane.y - mouseY;
    if (Math.sqrt(dx * dx + dy * dy) < 10) {
      selectedAircraft = plane;
      plane.tagAngle += Math.PI / 4;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      drawNavData();
      displayedAircraft = aircraftList.map(p => Object.assign(new Aircraft(), p));
      displayedAircraft.forEach(plane => plane.draw());
    }
  });
});

function handleCommandInput(event, action) {
  if (event.key === "Enter") {
    if (selectedAircraft) {
      const value = parseFloat(event.target.value);
      if (!isNaN(value)) {
        action(value);
      }
    } else {
      console.log("No aircraft selected to give command to.");
    }
  }
}

headingInput.addEventListener("keydown", (e) => {
  handleCommandInput(e, (val) => selectedAircraft.setHeading(val));
});

speedInput.addEventListener("keydown", (e) => {
  handleCommandInput(e, (val) => selectedAircraft.setSpeed(val));
});

altitudeInput.addEventListener("keydown", (e) => {
  handleCommandInput(e, (val) => selectedAircraft.setAltitude(val));
});

// --- START THE GAME ---
aircraftList.push(new Aircraft("BAW123", 100, 100, 135, 180, 230));
aircraftList.push(new Aircraft("AWE456", 700, 600, 225, 160, 160));
displayedAircraft = aircraftList.map(p => Object.assign(new Aircraft(), p));
selectedAircraft = aircraftList[0];

resizeCanvas();
loadNavData();
requestAnimationFrame(gameLoop);
