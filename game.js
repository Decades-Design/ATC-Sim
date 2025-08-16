// --- GLOBAL VARIABLES ---
const canvas = document.getElementById("radar-scope");
const ctx = canvas.getContext("2d"); // The drawing tool for the canvas
const uiPanel = document.getElementById("ui-panel");
const headingInput = document.getElementById("heading-input");
const speedInput = document.getElementById("speed-input");
const altitudeInput = document.getElementById("altitude-input");

// --- SIMULATION SETTINGS ---
const centerCoord = { lat: 45.44944444, lon: 9.27833333 }; // Centre coordinates
const radarRangeNM = 30; // The distance from the center to the edge of the screen in nautical miles

const activeAirports = {
  "LIML": ["RW35"],
  "LIMC": ["RW35R"]
};

const SWEEP_INTERVAL_MS = 2000;

// --- GEOGRAPHICAL CONSTANTS AND HELPERS ---
const NM_TO_KM = 1.852;
const KNOTS_TO_KPS = 0.000514444;
const FEET_TO_KM = 0.0003048;

// These will be calculated dynamically based on the center and range
let minLon, maxLon, minLat, maxLat;

function calculateGeographicBounds() {
    const radarRangeKm = radarRangeNM * NM_TO_KM;
    const centerLatRad = centerCoord.lat * Math.PI / 180;

    // Calculate the change in latitude and longitude for the given range
    const latDelta = radarRangeKm / 111.32; // Approx km per degree of latitude
    const lonDelta = radarRangeKm / (111.32 * Math.cos(centerLatRad)); // Varies with latitude

    minLat = centerCoord.lat - latDelta;
    maxLat = centerCoord.lat + latDelta;
    minLon = centerCoord.lon - lonDelta;
    maxLon = centerCoord.lon + lonDelta;
}


// --- Settings ---
canvas.addEventListener("contextmenu", (e) => {
  e.preventDefault();
});

// --- GAME STATE ---
let aircraftList = [];
let navDataPoints = []; // Will hold navigation data points
let vorData = []; // Will hold VOR data loaded from the database
let airports = []; // Will hold airport data loaded from the database
let terminalWaypoints = []; // Will hold terminal waypoint data loaded from the database
let runways = []; // Will hold runway data loaded from the database
let ilsData = []; // Will hold ILS data loaded from the database
let approachPaths = []; // Will hold approach path data loaded from the database
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
  kmPerPixel = (radarRangeNM * NM_TO_KM * 2) / size; // Total width of scope in km / pixels
  drawNavData();
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
}

function latLonToPixel(lat, lon) {
  const x = ((lon - minLon) / (maxLon - minLon)) * canvas.width;
  const y = ((maxLat - lat) / (maxLat - minLat)) * canvas.height;
  return { x, y };
}

function drawNavData() {
  ctx.fillStyle = "rgba(0, 255, 0, 0.7)";
  ctx.strokeStyle = "rgba(0, 255, 0, 0.7)";
  ctx.font = '11px "Courier New"';
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";

    // --- Runways ---
  const drawnRunways = new Set(); // Keep track of runways we've already drawn
  runways.forEach(runway => {
    if (activeAirports[runway.airport] && activeAirports[runway.airport].includes(runway.id) && !drawnRunways.has(runway.id)) {
      
      // 1. Get the starting point (the threshold) in pixel coordinates.
      const p1 = latLonToPixel(runway.lat, runway.lon);
      let p2; // This will hold the coordinates of the other end.

      // 2. Try to find the opposite runway to get the most accurate endpoint.
      const rwyNum = parseInt(runway.id.substring(2, 4));
      const oppositeNum = rwyNum > 18 ? rwyNum - 18 : rwyNum + 18;
      const rwySide = runway.id.substring(4);
      let oppositeSide = '';
      if (rwySide === 'L') oppositeSide = 'R';
      if (rwySide === 'R') oppositeSide = 'L';
      if (rwySide === 'C') oppositeSide = 'C';
      
      const oppositeId = `RW${String(oppositeNum).padStart(2, '0')}${oppositeSide}`;
      const oppositeRunway = runways.find(r => r.id === oppositeId && r.airport === runway.airport);

      if (oppositeRunway) {
        // --- Primary Method ---
        // If the opposite runway is found, use its precise threshold coordinates.
        p2 = latLonToPixel(oppositeRunway.lat, oppositeRunway.lon);
        drawnRunways.add(oppositeRunway.id); // Mark the opposite as drawn as well.
      } else {
        // --- Backup Method ---
        // If no opposite is found, calculate the endpoint using length and bearing.
        const lengthPx = (runway.length * FEET_TO_KM) / kmPerPixel;
        const bearingRad = runway.trueBearing * Math.PI / 180;
        
        // Calculate the end point using the correct navigational trigonometry.
        p2 = {
          x: p1.x + Math.sin(bearingRad) * lengthPx,
          y: p1.y - Math.cos(bearingRad) * lengthPx
        };
      }

      // 3. Draw the runway using the determined start and end points.
      // This part is now the same for both methods.
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
      
      ctx.strokeStyle = "rgba(255, 255, 255, 1)"; // Pure white
      ctx.lineWidth = 4;
      ctx.stroke();

      // 4. Mark this runway as drawn.
      drawnRunways.add(runway.id);
    }
  });

  // --- Localizer ---
  ilsData.forEach(ils => {
    // OLD LINE: if (activeRunways.includes(ils.runway) && controlledAirports.includes(ils.airport)) {
    // --- NEW LOGIC (replace the line above with this) ---
    if (activeAirports[ils.airport] && activeAirports[ils.airport].includes(ils.runway)) {
      // Find the runway that this ILS belongs to.
      const runway = runways.find(r => r.id === ils.runway && r.airport === ils.airport);
      if (!runway) return; // Safety check in case the runway isn't found.

      // Get the pixel coordinates for the runway threshold.
      const threshold = latLonToPixel(runway.lat, runway.lon);

      // 1. Calculate the TRUE bearing for the ILS.
      // The database bearing is magnetic, so we add declination to get true north.
      const trueBearing = ils.bearing + ils.declination;
      const bearingRad = trueBearing * Math.PI / 180;

      // 2. Define the length of the localizer line (e.g., 10 NM).
      // --- Filter approachPaths for waypointType[3] === "B"
      const bTypeApproaches = approachPaths.filter(ap => ap.waypointType && ap.waypointType[3] === "B" && ap.icao === ils.airport);

      // --- Cut first two characters from runway id (e.g., "RW35L" -> "35L")
      const cutRunway = runway.id.substring(2);

      // --- Further filter for approaches whose id contains the cut runway string
      const matchingApproaches = bTypeApproaches.filter(ap => ap.id && ap.id.includes(cutRunway));
      
      let locLengthPx;
      if (matchingApproaches.length > 0) {
        // Count occurrences of each waypointId
        const idCounts = {};
        matchingApproaches.forEach(ap => {
          idCounts[ap.waypointId] = (idCounts[ap.waypointId] || 0) + 1;
        });
        // Find the most common waypointId(s)
        let mostCommonIds = [];
        let maxCount = 0;
        for (const id in idCounts) {
          if (idCounts[id] > maxCount) {
        maxCount = idCounts[id];
        mostCommonIds = [id];
          } else if (idCounts[id] === maxCount) {
        mostCommonIds.push(id);
          }
        }
        // Prefer waypointIds that do not contain numbers
        let preferredIds = mostCommonIds.filter(id => !/\d/.test(id));
        let chosenId;
        if (preferredIds.length > 0) {
          chosenId = preferredIds[0];
        } else {
          chosenId = mostCommonIds[0];
        }
        // Filter to only approaches with the chosen waypointId
        const filtered = matchingApproaches.filter(ap => ap.waypointId === chosenId);
        console.log("Filtered approaches:", filtered.map(ap => ap.waypointId));
        // Use the first (they all have the same waypointId now)
        const ap = filtered[0];
        // Calculate distance from threshold to waypoint (in km)
        const R = 6371; // Earth radius in km
        const toRad = deg => deg * Math.PI / 180;
        const dLat = toRad(ap.waypointLat - runway.lat);
        const dLon = toRad(ap.waypointLon - runway.lon);
        const a = Math.sin(dLat / 2) ** 2 +
                  Math.cos(toRad(runway.lat)) * Math.cos(toRad(ap.waypointLat)) *
                  Math.sin(dLon / 2) ** 2;
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        const distKm = R * c;
        locLengthPx = distKm / kmPerPixel;
      } else {
        locLengthPx = (15 * NM_TO_KM) / kmPerPixel;
      }

      // 3. Calculate the end point of the line.
      // We start at the threshold and go "backwards" along the approach path.
      // This uses the correct navigational-to-canvas coordinate conversion.
      const endX = threshold.x - Math.sin(bearingRad) * locLengthPx;
      const endY = threshold.y + Math.cos(bearingRad) * locLengthPx;

      // 4. Draw the line.
      ctx.beginPath();
      ctx.moveTo(threshold.x, threshold.y); // Start at the runway threshold.
      ctx.lineTo(endX, endY);               // Extend out along the approach course.
      
      ctx.strokeStyle = "rgba(255, 255, 0, 0.7)"; // Yellow for ILS
      ctx.lineWidth = 3;
      ctx.stroke();
    }
  });

  navDataPoints.forEach(point => {
    const x = ((point.lon - minLon) / (maxLon - minLon)) * canvas.width;
    const y = ((maxLat - point.lat) / (maxLat - minLat)) * canvas.height;

    if (point.type[0] === 'C' || point.type[0] === 'R') {
      const size = 6; // You can adjust this value or make it a parameter
      ctx.beginPath();
      ctx.moveTo(x, y - size * 0.75); // Top point (75% of size)
      ctx.lineTo(x - size * 0.6, y + size * 0.45); // Bottom left
      ctx.lineTo(x + size * 0.6, y + size * 0.45); // Bottom right
      ctx.closePath();
      ctx.fill();
    } else if (point.type[0] === 'W') {
      const size = 5; // Size of the star
      const innerSize = size / 2.5;
      ctx.beginPath();
      
      // 1. Top point
      ctx.moveTo(x, y - size);
      // 2. Inner point (top-right)
      ctx.lineTo(x + innerSize, y - innerSize);
      // 3. Right point
      ctx.lineTo(x + size, y);
      // 4. Inner point (bottom-right)
      ctx.lineTo(x + innerSize, y + innerSize);
      // 5. Bottom point
      ctx.lineTo(x, y + size);
      // 6. Inner point (bottom-left)
      ctx.lineTo(x - innerSize, y + innerSize);
      // 7. Left point
      ctx.lineTo(x - size, y);
      // 8. Inner point (top-left)
      ctx.lineTo(x - innerSize, y - innerSize);

      ctx.closePath();
      ctx.fill();
    }

    // Only display name if it does NOT contain a number
    if (!/\d/.test(point.name)) {
      ctx.fillText(point.name, x + 8, y);
    }
  });

  // --- Draw Terminal Waypoints ---
  terminalWaypoints.forEach(point => {
    if (activeAirports[point.airport] && !/\d/.test(point.name)) {
      const x = ((point.lon - minLon) / (maxLon - minLon)) * canvas.width;
      const y = ((maxLat - point.lat) / (maxLat - minLat)) * canvas.height;

      if (point.type[0] === 'C' || point.type[0] === 'R') {
        const size = 6; // You can adjust this value or make it a parameter
        ctx.beginPath();
        ctx.moveTo(x, y - size * 0.75); // Top point (75% of size)
        ctx.lineTo(x - size * 0.6, y + size * 0.45); // Bottom left
        ctx.lineTo(x + size * 0.6, y + size * 0.45); // Bottom right
        ctx.closePath();
        ctx.fill();
      } else if (point.type[0] === 'W') {
        const size = 5; // Size of the star
        const innerSize = size / 2.5;
        ctx.beginPath();
        
        // 1. Top point
        ctx.moveTo(x, y - size);
        // 2. Inner point (top-right)
        ctx.lineTo(x + innerSize, y - innerSize);
        // 3. Right point
        ctx.lineTo(x + size, y);
        // 4. Inner point (bottom-right)
        ctx.lineTo(x + innerSize, y + innerSize);
        // 5. Bottom point
        ctx.lineTo(x, y + size);
        // 6. Inner point (bottom-left)
        ctx.lineTo(x - innerSize, y + innerSize);
        // 7. Left point
        ctx.lineTo(x - size, y);
        // 8. Inner point (top-left)
        ctx.lineTo(x - innerSize, y - innerSize);

        ctx.closePath();
        ctx.fill();
      }

      // Only display name if it does NOT contain a number
      if (!/\d/.test(point.name)) {
        ctx.fillText(point.name, x + 8, y);
      }
    }
  });

  vorData.forEach(vor => {
    const size = 5; // Size of the star

    const x = ((vor.lon - minLon) / (maxLon - minLon)) * canvas.width;
    const y = ((maxLat - vor.lat) / (maxLat - minLat)) * canvas.height;

    // Draw the VOR symbol
    drawVorSymbol(ctx, x, y, size);
    ctx.fillText(vor.id, x + 8, y);

    if (vor.type[1] === 'D') {
        const boxSize = size * 2.5;
        ctx.strokeStyle = "rgba(0, 255, 0, 0.7)";
        ctx.lineWidth = 1.5;
        ctx.strokeRect(x - boxSize / 2, y - boxSize / 2, boxSize, boxSize);
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
  displayedAircraft.forEach(plane => plane.draw());
  drawNavData();

  requestAnimationFrame(gameLoop);
}

// --- NAV DATA LOADING ---
function loadNavData() {
  // --- Paths ---
  const wasmPath = 'node_modules/sql.js/dist/sql-wasm.wasm';
  const dbPath = 'NavData/navdb.s3db';

  // --- Initialize SQL.js and Load Database ---
  initSqlJs({ locateFile: () => wasmPath })
    .then(function(SQL) {
      return fetch(dbPath)
        .then(response => {
          if (!response.ok) {
            throw new Error(`Failed to fetch database: ${response.statusText}`);
          }
          return response.arrayBuffer();
        })
        .then(filebuffer => {
          const dbObject = new SQL.Database(new Uint8Array(filebuffer));

          // --- Load Waypoints ---
          let query = `
            SELECT * FROM main.tbl_enroute_waypoints 
            WHERE 
              waypoint_longitude BETWEEN ${minLon} AND ${maxLon}
              AND waypoint_latitude BETWEEN ${minLat} AND ${maxLat}
              AND waypoint_identifier NOT LIKE 'VP%'
              AND waypoint_type != 'U'
          `;
          const result = dbObject.exec(query);
          if (result.length > 0 && result[0].values.length > 0) {
            navDataPoints = result[0].values.map(row => ({
              name: row[2], // ident column
              type: row[4], // type column
              lon:  row[7], // lonx column
              lat:  row[6]  // laty column
            }));
          }

          // --- Load Airports ---
          query = `
            SELECT * FROM tbl_airports 
            WHERE
              airport_ref_longitude BETWEEN ${minLon} AND ${maxLon}
              AND airport_ref_latitude BETWEEN ${minLat} AND ${maxLat}
              AND ifr_capability = 'Y'
          `;
          const airportResult = dbObject.exec(query);
          if (airportResult.length > 0 && airportResult[0].values.length > 0) {
            airports = airportResult[0].values.map(row => ({
              icao: row[2],    // icao column  
              name: row[4],    // Name column
              lon: row[6],    // lonx column
              lat: row[5],     // laty column
              TA: row[10],     // transition altitude column
              TL: row[11],     // transition level column
              elevation: row[9] // elevation column
            }));
          }

          // --- Load VORs ---
          query = `
            SELECT * FROM main.tbl_vhfnavaids 
            WHERE
              vor_longitude BETWEEN ${minLon} AND ${maxLon}
              AND vor_latitude BETWEEN ${minLat} AND ${maxLat}
              AND navaid_class like 'V%'
          `;
          const vorResult = dbObject.exec(query);
          if (vorResult.length > 0 && vorResult[0].values.length > 0) {
            vorData = vorResult[0].values.map(row => ({
              id: row[3],     // vor_id column
              name: row[4],   // name column
              type: row[6],   // type column
              lon: row[8],    // lonx column
              lat: row[7]     // laty column
            }));
          }

          // --- Load Terminal Waypoints ---
          query = `
            SELECT * FROM tbl_terminal_waypoints
            WHERE
              waypoint_longitude BETWEEN ${minLon} AND ${maxLon}
              AND waypoint_latitude BETWEEN ${minLat} AND ${maxLat}
              AND waypoint_identifier NOT LIKE 'VP%'
          `;
          const terminalResult = dbObject.exec(query);
          if (terminalResult.length > 0 && terminalResult[0].values.length > 0) {
            terminalWaypoints = terminalResult[0].values.map(row => ({
              name: row[3],   // ident column
              airport: row[1], // airport column
              type: row[5],   // type column
              lon: row[7],    // lonx column
              lat: row[6]     // laty column
            }));
          }

          // --- Load Runways ---
          query = `
            SELECT * FROM tbl_runways
            WHERE
              runway_longitude BETWEEN ${minLon} AND ${maxLon}
              AND runway_latitude BETWEEN ${minLat} AND ${maxLat}
          `;
          const runwayResult = dbObject.exec(query);
          if (runwayResult.length > 0 && runwayResult[0].values.length > 0) {
            runways = runwayResult[0].values.map(row => ({
              id: row[3],     // runway_id column
              airport: row[2],   // airport column
              lon: row[5],    // lonx column
              lat: row[4],     // laty column
              length: row[12],  // length column
              width: row[13],   // width column
              thrElevation: row[9], // landing threshold elevation column
              thrXelevation: row[11], // landing threshold crossing elevation column
              magBearing: row[7], // magnetic bearing column
              trueBearing: row[8] // true bearing column
            }));
          }

          // --- ILSs ---
          query = `
            SELECT * FROM tbl_localizers_glideslopes
            WHERE
              llz_longitude BETWEEN ${minLon} AND ${maxLon}
              AND llz_latitude BETWEEN ${minLat} AND ${maxLat}
          `;
          const ilsResult = dbObject.exec(query);
          if (ilsResult.length > 0 && ilsResult[0].values.length > 0) {
            ilsData = ilsResult[0].values.map(row => ({
              airport: row[2], // airport column
              runway: row[3], // runway column
              id: row[4],     // ils_id column
              type: row[10],   // type column
              lon: row[6],    // lonx column
              lat: row[5],     // laty column
              bearing: row[8],  // bearing column
              width: row[9],     // width column
              gsLat: row[11],     // glideslope latitude column
              gsLon: row[12],      // glideslope longitude column
              gsAngle: row[13],     // glideslope angle column
              gsElevation: row[14],   // glideslope elevation column
              declination: row[15]    // declination column
            }));
          }

          // --- Approach Paths ---
          const icaoCodes = airports.map(airport => airport.icao);
          const icaoListForSQL = icaoCodes.map(code => `'${code}'`).join(',');
          query = `
            SELECT * FROM tbl_iaps 
            WHERE 
              airport_identifier IN (${icaoListForSQL})
          `;
          const approachResult = dbObject.exec(query);
          if (approachResult.length > 0 && approachResult[0].values.length > 0) {
            approachPaths = approachResult[0].values.map(row => ({
              icao: row[1], // ICAO code
              id: row[2],    // IAP ID
              routeType: row[3], // Route type
              transitionId: row[4], // Transition ID
              seqno: row[5], // Sequence number
              waypointId: row[7], // Waypoint ID
              waypointLat: row[8], // Waypoint Latitude
              waypointLon: row[9], // Waypoint Longitude
              waypointType: row[10], // Waypoint Type
              turnDirection: row[11], // Turn Direction
              pathTerm: row[13], // Path Termination
              navaid: row[14], // Navaid
              navaidLat: row[15], // Navaid Latitude
              navaidLon: row[16], // Navaid Longitude
              arcRadius: row[17], // Arc Radius
              theta: row[18], // Theta
              rho: row[19], // Rho
              magCourse: row[20], // Magnetic Course
              routeHoldDistanceTime: row[21], // Route Hold Distance Time
              distanceOrTime: row[22], // Distance or Time
              altitudeDescription: row[23], // Altitude Description
              altitude1: row[24], // Altitude 1
              altitude2: row[25], // Altitude 2
              transitionAlt: row[26], // Transition Altitude
              speedLimitDescription: row[27], // Speed Limit Description
              speedLimit: row[28], // Speed Limit
              verticalAngle: row[29] // Vertical Angle
            }));
          }

          dbObject.close();
        });
    })
    .catch(err => {
      // Handle errors silently or log if needed
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

calculateGeographicBounds(); // 1. Set up the geographic area
loadNavData();             // 2. Load the data for that area
resizeCanvas();              // 3. Size the canvas
requestAnimationFrame(gameLoop); // 4. Start the animation