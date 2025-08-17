// ================================================================================= //
//                                    UI & CANVAS ELEMENT GLOBALS                    //
// ================================================================================= //
const canvas = document.getElementById("radar-scope");
const ctx = canvas.getContext("2d");

const navdataCanvas = document.getElementById("navdata-canvas");
const navCtx = navdataCanvas.getContext("2d");
const canvasStack = document.getElementById("canvas-stack");

const uiPanel = document.getElementById("ui-panel");
const headingInput = document.getElementById("heading-input");
const speedInput = document.getElementById("speed-input");
const altitudeInput = document.getElementById("altitude-input");

// ================================================================================= //
//                                      CORE SIMULATION SETTINGS                     //
// ================================================================================= //
const centerCoord = { lat: 45.44944444, lon: 9.27833333 }; // Centre coordinates
const radarRangeNM = 30; // The distance from the center to the edge of the screen in nautical miles

// This object defines which airports and runways are currently active and should be rendered.
// This is a key setting for defining the playable area.
const activeAirports = {
  "LIML": ["RW35"],
  "LIMC": ["RW35R"]
};

// The time in milliseconds for a full radar sweep. This controls the refresh rate of aircraft positions.
const SWEEP_INTERVAL_MS = 2000;

// ================================================================================= //
//                                 GEOGRAPHICAL CONSTANTS & HELPERS                  //
// ================================================================================= //
const NM_TO_KM = 1.852; // Nautical Miles to Kilometers
const KNOTS_TO_KPS = 0.000514444; // Knots (nautical miles per hour) to Kilometers Per Second
const FEET_TO_KM = 0.0003048; // Feet to Kilometers

// These global variables will define the geographic bounding box for the radar scope.
// They are calculated by `calculateGeographicBounds` before loading data.
let minLon, maxLon, minLat, maxLat;

/**
 * Calculates the max/min latitude and longitude based on the simulation's center point and radar range.
 * This defines the rectangular area for which navigation data will be queried.
 * This is a simplified calculation and works best for areas not too close to the poles.
 */
function calculateGeographicBounds() {
    const radarRangeKm = radarRangeNM * NM_TO_KM;
    const centerLatRad = centerCoord.lat * Math.PI / 180;

    // Calculate the approximate change in latitude and longitude for the given radar range.
    const latDelta = radarRangeKm / 111.32; // Approx 111.32 km per degree of latitude.
    const lonDelta = radarRangeKm / (111.32 * Math.cos(centerLatRad)); // Longitude delta depends on latitude.

    // Set the global bounding box variables.
    minLat = centerCoord.lat - latDelta;
    maxLat = centerCoord.lat + latDelta;
    minLon = centerCoord.lon - lonDelta;
    maxLon = centerCoord.lon + lonDelta;
}


// ================================================================================= //
//                                          GAME STATE                               //
// ================================================================================= //
let aircraftList = []; // The master list of all aircraft in the simulation.
let navDataPoints = []; // Holds all en-route waypoints loaded from the database.
let vorData = []; // Holds all VOR navaids loaded from the database.
let airports = []; // Holds all airport data loaded from the database.
let terminalWaypoints = []; // Holds all terminal waypoints (SIDs/STARs) loaded from the database.
let runways = []; // Holds all runway data loaded from the database.
let ilsData = []; // Holds all ILS (localizer/glideslope) data loaded from the database.
let approachPaths = []; // Holds all instrument approach procedure data.
let selectedAircraft = null; // The aircraft currently selected by the user.
let radarRadius; // The radius of the radar scope in pixels, calculated on resize.
let kmPerPixel; // The ratio of kilometers to pixels, used for converting real-world distances to screen distances.

// ================================================================================= //
//                                    TIMING & ANIMATION STATE                       //
// ================================================================================= //
let lastUpdateTime = 0; // The timestamp of the last frame update.
let timeSinceLastSweep = 0; // Time accumulator for the radar sweep effect.
let displayedAircraft = []; // A 'frozen' snapshot of aircraft states, updated every sweep.

// ================================================================================= //
//                                     AIRCRAFT CLASS DEFINITION                     //
// ================================================================================= //
class Aircraft {
  /**
   * Represents a single aircraft in the simulation.
   * @param {string} callsign - The aircraft's unique identifier.
   * @param {number} lat - The initial latitude.
   * @param {number} lon - The initial longitude.
   * @param {number} heading - The initial heading in degrees.
   * @param {number} altitude - The initial altitude in feet.
   * @param {number} speed - The initial speed in knots.
   * @param {number} [tagAngle=0] - The initial angle for the data tag, in radians.
   */
  constructor(callsign, lat, lon, heading, altitude, speed, tagAngle) {
    this.callsign = callsign;
    // NEW: Position is stored as geographical coordinates, not pixels.
    this.lat = lat;
    this.lon = lon;

    // Current and target values for aircraft parameters.
    this.heading = heading;
    this.targetHdg = heading;
    this.altitude = altitude;
    this.targetAlt = altitude;
    this.speed = speed;
    this.targetSpd = speed;

    this.tagAngle = tagAngle || 0;
  }

  /**
   * Updates the aircraft's geographical position based on its speed, heading, and the time elapsed.
   * @param {number} deltaTime - The time in seconds since the last update.
   */
  update(deltaTime) {
    const speedInKps = this.speed * KNOTS_TO_KPS;
    const distanceMovedKm = speedInKps * deltaTime;
    const bearingRad = this.heading * Math.PI / 180;
    const latRad = this.lat * Math.PI / 180;
    const R = 6371; // Earth's radius in km

    // NEW: This is a more complex calculation to update lat/lon based on distance and bearing.
    const newLatRad = Math.asin(Math.sin(latRad) * Math.cos(distanceMovedKm / R) +
      Math.cos(latRad) * Math.sin(distanceMovedKm / R) * Math.cos(bearingRad));
    const newLonRad = (this.lon * Math.PI / 180) + Math.atan2(Math.sin(bearingRad) * Math.sin(distanceMovedKm / R) * Math.cos(latRad),
      Math.cos(distanceMovedKm / R) - Math.sin(latRad) * Math.sin(newLatRad));

    this.lat = newLatRad * 180 / Math.PI;
    this.lon = newLonRad * 180 / Math.PI;
  }

  /**
   * Draws the aircraft and its associated data on the canvas.
   */
  draw() {
    // Convert lat/lon to pixel coordinates right before drawing.
    const { x, y } = latLonToPixel(this.lat, this.lon);

    // --- Draw the aircraft symbol (a circle) ---
    ctx.beginPath();
    ctx.arc(x, y, 4, 0, 2 * Math.PI);
    ctx.globalAlpha = 1;
    ctx.fillStyle = "#0f0";
    ctx.fill();
    ctx.globalAlpha = 1;

    // --- Draw the speed vector line ---
    const lineTimeLength = 60; // seconds
    const speedInKps = this.speed * KNOTS_TO_KPS;
    const distanceKm = speedInKps * lineTimeLength;
    const lineLength = distanceKm / kmPerPixel;
    const rad = (this.heading * Math.PI) / 180;
    const endX = x + Math.sin(rad) * lineLength;
    const endY = y - Math.cos(rad) * lineLength;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(endX, endY);
    ctx.strokeStyle = "#0f0";
    ctx.lineWidth = 2;
    ctx.stroke();

    // --- Draw the data tag (callsign, altitude, speed) ---
    ctx.font = '12px "Courier New"';
    const tagRadius = 40;
    const tagX = x + tagRadius * Math.cos(this.tagAngle);
    const tagY = y + tagRadius * Math.sin(this.tagAngle);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    
    // CHANGED: Convert altitude to Flight Level for display (e.g., 18000 ft -> "180")
    const flightLevel = Math.round(this.altitude / 100).toString().padStart(3, '0');

    ctx.fillText(this.callsign, tagX, tagY - 8);
    ctx.fillText(`${flightLevel}  ${Math.round(this.speed)}`, tagX, tagY + 8);
  }

  // --- The setHeading, setSpeed, and setAltitude methods remain unchanged. ---
  // (You can leave them as they are in your original file)
  setHeading(newHeading) {
    if (this._headingInterval) clearInterval(this._headingInterval); // Stop any existing turn.

    // Helper to keep heading values between 0 and 360.
    const normalize = h => ((h % 360) + 360) % 360;
    const current = normalize(this.heading);
    this.targetHdg = normalize(newHeading);
    let diff = this.targetHdg - current;
    if (diff > 180) diff -= 360;
    if (diff < -180) diff += 360;
    const turnRate = 2; // Degrees per second
    const intervalMs = 30; // Update interval in milliseconds
    const step = turnRate * (intervalMs / 1000) * Math.sign(diff); // Degrees to turn in each step

    // Use an interval to incrementally change the heading.
    this._headingInterval = setInterval(() => {
      let cur = normalize(this.heading);
      let d = this.targetHdg - cur;
      // Ensure we're turning the shortest way
      if (d > 180) d -= 360;
      if (d < -180) d += 360;

      // If the remaining turn is smaller than a step, just snap to the target.
      if (Math.abs(d) <= Math.abs(step)) {
        this.heading = this.targetHdg;
        clearInterval(this._headingInterval);
        this._headingInterval = null;
      } else {
        this.heading = normalize(cur + step); // Turn by one step
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
    const duration = Math.abs(newAltitude - this.altitude) * 6;
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

// ================================================================================= //
//                                     CANVAS & DRAWING FUNCTIONS                    //
// ================================================================================= //

function pixelToLatLon(x, y) {
  const lon = (x / navdataCanvas.width) * (maxLon - minLon) + minLon;
  const lat = maxLat - (y / navdataCanvas.height) * (maxLat - minLat);
  return { lat, lon };
}

function latLonToPixel(lat, lon) {
  const x = ((lon - minLon) / (maxLon - minLon)) * navdataCanvas.width;
  const y = ((maxLat - lat) / (maxLat - minLat)) * navdataCanvas.height;
  return { x, y };
}

function resizeCanvas() {
  const padding = 20;
  const gap = 10;
  const availableWidth = window.innerWidth - uiPanel.offsetWidth - padding - gap;
  const availableHeight = window.innerHeight - padding;
  const size = Math.min(availableWidth, availableHeight);

  canvasStack.style.width = `${size}px`;
  canvasStack.style.height = `${size}px`;
  canvas.width = size;
  canvas.height = size;
  navdataCanvas.width = size;
  navdataCanvas.height = size;

  radarRadius = size / 2;
  kmPerPixel = (radarRangeNM * NM_TO_KM * 2) / size;

  drawNavData();
}

function drawVorSymbol(ctx, x, y, size) {
  ctx.beginPath();
  ctx.moveTo(x + size * Math.cos(0), y + size * Math.sin(0));
  for (let i = 1; i <= 6; i++) {
    const angle = i * Math.PI / 3;
    ctx.lineTo(x + size * Math.cos(angle), y + size * Math.sin(angle));
  }
  ctx.strokeStyle = "rgba(0, 255, 0, 0.7)";
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(x, y, 1.5, 0, 2 * Math.PI);
  ctx.fillStyle = "rgba(0, 255, 0, 0.7)";
  ctx.fill();
}

/**
 * Draws all static navigation data on the canvas.
 * This includes runways, ILS localizers, waypoints, and VORs.
 * This function is called on every frame to ensure the nav data is always visible.
 */
function drawNavData() {

  console.log("Drawing navigation data...");
  // --- Set default drawing styles for nav data ---
  navCtx.clearRect(0, 0, navdataCanvas.width, navdataCanvas.height);

  navCtx.fillStyle = "rgba(0, 255, 0, 0.7)";
  navCtx.strokeStyle = "rgba(0, 255, 0, 0.7)";
  navCtx.font = '11px "Courier New"';
  navCtx.textAlign = "left";
  navCtx.textBaseline = "middle";

  // --- Draw Runways ---
  // A Set is used to prevent drawing the same physical runway twice (e.g., RW18 and RW36 are the same pavement).
  const drawnRunways = new Set();
  runways.forEach(runway => {
    // Only draw runways that are part of an active airport and haven't been drawn yet.
    if (activeAirports[runway.airport] && activeAirports[runway.airport].includes(runway.id) && !drawnRunways.has(runway.id)) {

      // --- Determine Runway Endpoints ---
      // The goal is to find the pixel coordinates for both ends of the runway pavement.
      const p1 = latLonToPixel(runway.lat, runway.lon); // Start point is the runway's own threshold.
      let p2; // The other end of the runway.

      // The most accurate way to get the other end is to find the reciprocal runway in the database.
      const rwyNum = parseInt(runway.id.substring(2, 4));
      const oppositeNum = rwyNum > 18 ? rwyNum - 18 : rwyNum + 18; // e.g., 35 -> 17, 09 -> 27
      const rwySide = runway.id.substring(4); // e.g., 'L', 'R', 'C'
      let oppositeSide = '';
      if (rwySide === 'L') oppositeSide = 'R';
      if (rwySide === 'R') oppositeSide = 'L';
      if (rwySide === 'C') oppositeSide = 'C';

      const oppositeId = `RW${String(oppositeNum).padStart(2, '0')}${oppositeSide}`;
      const oppositeRunway = runways.find(r => r.id === oppositeId && r.airport === runway.airport);

      if (oppositeRunway) {
        // --- Primary Method: Use Reciprocal Runway's Coordinates ---
        p2 = latLonToPixel(oppositeRunway.lat, oppositeRunway.lon);
        drawnRunways.add(oppositeRunway.id); // Mark the reciprocal runway as drawn too.
      } else {
        // --- Backup Method: Calculate Endpoint using Length and Bearing ---
        // This is less accurate than using the reciprocal runway's data but is a reliable fallback.
        const lengthPx = (runway.length * FEET_TO_KM) / kmPerPixel; // Convert runway length to pixels
        const bearingRad = runway.trueBearing * Math.PI / 180;

        // Calculate the end point using trigonometry.
        p2 = {
          x: p1.x + Math.sin(bearingRad) * lengthPx,
          y: p1.y - Math.cos(bearingRad) * lengthPx // Y is inverted in canvas coordinates
        };
      }

      // --- Draw the Runway Line ---
      navCtx.beginPath();
      navCtx.moveTo(p1.x, p1.y);
      navCtx.lineTo(p2.x, p2.y);
      navCtx.strokeStyle = "rgba(255, 255, 255, 1)"; // Draw runways in pure white for high visibility.
      navCtx.lineWidth = 4;
      navCtx.stroke();

      // Mark the current runway as drawn to avoid re-processing.
      drawnRunways.add(runway.id);
    }
  });

  // --- Draw ILS Localizers ---
  // This section draws the extended centerline for runways with an active ILS.
  ilsData.forEach(ils => {
    // Check if the ILS corresponds to an active runway at an active airport.
    if (activeAirports[ils.airport] && activeAirports[ils.airport].includes(ils.runway)) {
      const runway = runways.find(r => r.id === ils.runway && r.airport === ils.airport);
      if (!runway) return; // Safety check: Can't draw ILS if its runway isn't loaded.

      const threshold = latLonToPixel(runway.lat, runway.lon);

      // 1. Calculate the TRUE bearing for the localizer.
      // The database provides magnetic bearing, so we must add declination to get the true bearing.
      const trueBearing = ils.bearing + ils.declination;
      const bearingRad = trueBearing * Math.PI / 180;

      // 2. Determine the length of the localizer line to draw.
      // This is a complex part: we try to find the Initial Approach Fix (IAF)
      // from the approach path data to draw the line out to that point.
      // If we can't find it, we default to a fixed length (e.g., 15 NM).

      // Filter approach paths for the current airport that are of a specific type ("B").
      const bTypeApproaches = approachPaths.filter(ap => ap.waypointType && ap.waypointType[3] === "B" && ap.icao === ils.airport);
      const cutRunway = runway.id.substring(2); // e.g., "RW35L" -> "35L"
      const matchingApproaches = bTypeApproaches.filter(ap => ap.id && ap.id.includes(cutRunway));
      
      let locLengthPx;
      if (matchingApproaches.length > 0) {
        // --- Dynamic Length Calculation ---
        // This logic finds the most common initial waypoint for the approach
        // and calculates the distance to it. This makes the localizer line length
        // more realistic and data-driven.

        // Count occurrences of each potential starting waypoint ID.
        const idCounts = {};
        matchingApproaches.forEach(ap => {
          idCounts[ap.waypointId] = (idCounts[ap.waypointId] || 0) + 1;
        });

        // Find the most frequently occurring waypoint ID(s).
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

        // Prefer waypoints that don't contain numbers, as they are often named fixes.
        let preferredIds = mostCommonIds.filter(id => !/\d/.test(id));
        let chosenId = preferredIds.length > 0 ? preferredIds[0] : mostCommonIds[0];

        // Get the approach data for the chosen waypoint.
        const ap = matchingApproaches.find(ap => ap.waypointId === chosenId);

        // Calculate the distance from the runway threshold to this waypoint using the Haversine formula.
        const R = 6371; // Earth radius in km
        const toRad = deg => deg * Math.PI / 180;
        const dLat = toRad(ap.waypointLat - runway.lat);
        const dLon = toRad(ap.waypointLon - runway.lon);
        const a = Math.sin(dLat / 2) ** 2 +
                  Math.cos(toRad(runway.lat)) * Math.cos(toRad(ap.waypointLat)) *
                  Math.sin(dLon / 2) ** 2;
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        const distKm = R * c;
        locLengthPx = distKm / kmPerPixel; // Convert distance to pixels.
      } else {
        // --- Fallback Length ---
        // If no matching approach path is found, use a default length of 15 NM.
        locLengthPx = (15 * NM_TO_KM) / kmPerPixel;
      }

      // 3. Calculate the end point of the localizer line.
      // We start at the runway threshold and extend "backwards" along the approach course.
      const endX = threshold.x - Math.sin(bearingRad) * locLengthPx;
      const endY = threshold.y + Math.cos(bearingRad) * locLengthPx;

      // 4. Draw the localizer line.
      navCtx.beginPath();
      navCtx.moveTo(threshold.x, threshold.y); // Start at the runway threshold.
      navCtx.lineTo(endX, endY);               // Extend out along the approach course.
      navCtx.strokeStyle = "rgba(255, 255, 0, 0.7)"; // Yellow for ILS
      navCtx.lineWidth = 3;
      navCtx.stroke();
    }
  });

  // --- Draw En-route Waypoints ---
  // These are waypoints not associated with a specific airport's terminal area.
  navDataPoints.forEach(point => {
    const { x, y } = latLonToPixel(point.lat, point.lon);

    // Draw different shapes based on the waypoint type.
    if (point.type[0] === 'C' || point.type[0] === 'R') {
      // 'C' and 'R' types are drawn as triangles.
      const size = 6;
      navCtx.beginPath();
      navCtx.moveTo(x, y - size * 0.75); // Top point
      navCtx.lineTo(x - size * 0.6, y + size * 0.45); // Bottom left
      navCtx.lineTo(x + size * 0.6, y + size * 0.45); // Bottom right
      navCtx.closePath();
      navCtx.fill();
    } else if (point.type[0] === 'W') {
      // 'W' type (standard waypoint) is drawn as a star.
      const size = 5;
      const innerSize = size / 2.5;
      navCtx.beginPath();
      navCtx.moveTo(x, y - size); // Top point
      navCtx.lineTo(x + innerSize, y - innerSize); // Inner top-right
      navCtx.lineTo(x + size, y); // Right point
      navCtx.lineTo(x + innerSize, y + innerSize); // Inner bottom-right
      navCtx.lineTo(x, y + size); // Bottom point
      navCtx.lineTo(x - innerSize, y + innerSize); // Inner bottom-left
      navCtx.lineTo(x - size, y); // Left point
      navCtx.lineTo(x - innerSize, y - innerSize); // Inner top-left
      navCtx.closePath();
      navCtx.fill();
    }

    // Only display the waypoint name if it doesn't contain numbers (filters out runway-specific fixes).
    if (!/\d/.test(point.name)) {
      navCtx.fillText(point.name, x + 8, y);
    }
  });

  // --- Draw Terminal Waypoints ---
  // These are waypoints associated with a specific airport (e.g., for SIDs and STARs).
  terminalWaypoints.forEach(point => {
    // Only draw waypoints for active airports and filter out numeric/unnamed ones.
    if (activeAirports[point.airport] && !/\d/.test(point.name)) {
      const { x, y } = latLonToPixel(point.lat, point.lon);

      // Draw the same triangle/star symbols as en-route waypoints.
      if (point.type[0] === 'C' || point.type[0] === 'R') {
        const size = 6;
        navCtx.beginPath();
        navCtx.moveTo(x, y - size * 0.75);
        navCtx.lineTo(x - size * 0.6, y + size * 0.45);
        navCtx.lineTo(x + size * 0.6, y + size * 0.45);
        navCtx.closePath();
        navCtx.fill();
      } else if (point.type[0] === 'W') {
        const size = 5;
        const innerSize = size / 2.5;
        navCtx.beginPath();
        navCtx.moveTo(x, y - size);
        navCtx.lineTo(x + innerSize, y - innerSize);
        navCtx.lineTo(x + size, y);
        navCtx.lineTo(x + innerSize, y + innerSize);
        navCtx.lineTo(x, y + size);
        navCtx.lineTo(x - innerSize, y + innerSize);
        navCtx.lineTo(x - size, y);
        navCtx.lineTo(x - innerSize, y - innerSize);
        navCtx.closePath();
        navCtx.fill();
      }

      if (!/\d/.test(point.name)) {
        navCtx.fillText(point.name, x + 8, y);
      }
    }
  });

  // --- Draw VOR/DME Navaids ---
  vorData.forEach(vor => {
    const size = 5;
    const { x, y } = latLonToPixel(vor.lat, vor.lon);

    // Draw the core VOR symbol (a hexagon).
    drawVorSymbol(navCtx, x, y, size);
    navCtx.fillText(vor.id, x + 8, y);

    // If the navaid has DME capability (type includes 'D'), draw a square box around it.
    if (vor.type[1] === 'D') {
      const boxSize = size * 2.5;
      navCtx.strokeStyle = "rgba(0, 255, 0, 0.7)";
      navCtx.lineWidth = 1.5;
      navCtx.strokeRect(x - boxSize / 2, y - boxSize / 2, boxSize, boxSize);
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

  // --- OPTIMIZED DRAWING ---
  // 1. Clear only the top (aircraft) canvas. The bottom canvas is untouched.
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  // 2. Draw the aircraft on the transparent top canvas.
  displayedAircraft.forEach(plane => plane.draw());

  requestAnimationFrame(gameLoop);
}

// ================================================================================= //
//                                   NAVIGATION DATABASE LOADER                      //
// ================================================================================= //
function loadNavData() {
  // Define paths for the SQL.js WebAssembly file and the SQLite database file.
  const wasmPath = 'node_modules/sql.js/dist/sql-wasm.wasm';
  const dbPath = 'NavData/navdb.s3db';

  // Initialize SQL.js and load the database file.
  initSqlJs({ locateFile: () => wasmPath })
    .then(SQL => {
      // Fetch the database file from the server.
      return fetch(dbPath)
        .then(response => {
          if (!response.ok) {
            throw new Error(`Failed to fetch database: ${response.statusText}`);
          }
          return response.arrayBuffer(); // Get the database file as an ArrayBuffer.
        })
        .then(filebuffer => {
          // Create a new database instance from the loaded file.
          const dbObject = new SQL.Database(new Uint8Array(filebuffer));

          // --- Load En-route Waypoints ---
          // Selects all waypoints within the current map's geographical boundaries.
          // It filters out certain unnamed or problematic waypoints (like 'VP%' or type 'U').
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
            // Map the query results to a more usable array of objects.
            navDataPoints = result[0].values.map(row => ({
              name: row[2], // waypoint_identifier
              type: row[4], // waypoint_type
              lon:  row[7], // waypoint_longitude
              lat:  row[6]  // waypoint_latitude
            }));
          }

          // --- Load Airports ---
          // Selects all airports within the map boundaries that have IFR capability.
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
              icao: row[2],      // icao_identifier
              name: row[4],      // airport_name
              lon: row[6],       // airport_ref_longitude
              lat: row[5],       // airport_ref_latitude
              TA: row[10],       // transition_altitude
              TL: row[11],       // transition_level
              elevation: row[9]  // elevation
            }));
          }

          // --- Load VORs ---
          // Selects all VOR and VOR/DME navaids within the map boundaries.
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
              id: row[3],     // vor_identifier
              name: row[4],   // navaid_name
              type: row[6],   // navaid_class
              lon: row[8],    // vor_longitude
              lat: row[7]     // vor_latitude
            }));
          }

          // --- Load Terminal Waypoints ---
          // Selects terminal-area waypoints (for SIDs/STARs) within the map boundaries.
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
              name: row[3],   // waypoint_identifier
              airport: row[1], // airport_identifier
              type: row[5],   // waypoint_type
              lon: row[7],    // waypoint_longitude
              lat: row[6]     // waypoint_latitude
            }));
          }

          // --- Load Runways ---
          // Selects all runway thresholds within the map boundaries.
          query = `
            SELECT * FROM tbl_runways
            WHERE
              runway_longitude BETWEEN ${minLon} AND ${maxLon}
              AND runway_latitude BETWEEN ${minLat} AND ${maxLat}
          `;
          const runwayResult = dbObject.exec(query);
          if (runwayResult.length > 0 && runwayResult[0].values.length > 0) {
            runways = runwayResult[0].values.map(row => ({
              id: row[3],           // runway_identifier
              airport: row[2],      // airport_identifier
              lon: row[5],          // runway_longitude
              lat: row[4],          // runway_latitude
              length: row[12],      // runway_length
              width: row[13],       // runway_width
              thrElevation: row[9], // landing_threshold_elevation
              thrXelevation: row[11],// visual_glide_path_angle
              magBearing: row[7],   // magnetic_bearing
              trueBearing: row[8]   // true_bearing
            }));
          }

          // --- Load ILS Data (Localizers and Glideslopes) ---
          // Selects all ILS components within the map boundaries.
          query = `
            SELECT * FROM tbl_localizers_glideslopes
            WHERE
              llz_longitude BETWEEN ${minLon} AND ${maxLon}
              AND llz_latitude BETWEEN ${minLat} AND ${maxLat}
          `;
          const ilsResult = dbObject.exec(query);
          if (ilsResult.length > 0 && ilsResult[0].values.length > 0) {
            ilsData = ilsResult[0].values.map(row => ({
              airport: row[2],     // airport_identifier
              runway: row[3],      // runway_identifier
              id: row[4],          // llz_identifier
              type: row[10],       // category
              lon: row[6],         // llz_longitude
              lat: row[5],         // llz_latitude
              bearing: row[8],     // llz_magnetic_bearing
              width: row[9],       // llz_width
              gsLat: row[11],      // gs_latitude
              gsLon: row[12],      // gs_longitude
              gsAngle: row[13],    // gs_angle
              gsElevation: row[14],// gs_elevation
              declination: row[15] // magnetic_variation
            }));
          }

          // --- Load Instrument Approach Procedures (IAPs) ---
          // This is crucial for drawing accurate ILS localizer lines out to the initial approach fix.
          // It selects all IAPs for the airports that were previously loaded.
          const icaoCodes = airports.map(airport => airport.icao);
          const icaoListForSQL = icaoCodes.map(code => `'${code}'`).join(',');
          query = `
            SELECT * FROM tbl_iaps 
            WHERE 
              airport_identifier IN (${icaoListForSQL})
          `;
          const approachResult = dbObject.exec(query);
          if (approachResult.length > 0 && approachResult[0].values.length > 0) {
            // This maps a large number of columns from the IAP table.
            // These are used to determine approach transitions and fix locations.
            approachPaths = approachResult[0].values.map(row => ({
              icao: row[1],
              id: row[2],
              routeType: row[3],
              transitionId: row[4],
              seqno: row[5],
              waypointId: row[7],
              waypointLat: row[8],
              waypointLon: row[9],
              waypointType: row[10],
              turnDirection: row[11],
              pathTerm: row[13],
              navaid: row[14],
              navaidLat: row[15],
              navaidLon: row[16],
              arcRadius: row[17],
              theta: row[18],
              rho: row[19],
              magCourse: row[20],
              routeHoldDistanceTime: row[21],
              distanceOrTime: row[22],
              altitudeDescription: row[23],
              altitude1: row[24],
              altitude2: row[25],
              transitionAlt: row[26],
              speedLimitDescription: row[27],
              speedLimit: row[28],
              verticalAngle: row[29]
            }));
          }

          dbObject.close();

          drawNavData();
        });
    })
    .catch(err => {
      // Handle errors silently or log if needed
    });
}

// ================================================================================= //
//                                     USER INPUT & EVENT LISTENERS                  //
// ================================================================================= //
window.addEventListener("resize", resizeCanvas);

// --- Prevent context menu on right-click ---
canvas.addEventListener("contextmenu", (e) => {
  e.preventDefault();
});

// --- Aircraft Selection (Left Click) ---
canvas.addEventListener("click", (e) => {
  const rect = canvas.getBoundingClientRect();
  const mouseX = e.clientX - rect.left;
  const mouseY = e.clientY - rect.top;

  aircraftList.forEach((plane) => {
    // Get the plane's current pixel position for the click check.
    const { x, y } = latLonToPixel(plane.lat, plane.lon);
    const dx = x - mouseX;
    const dy = y - mouseY;
    if (Math.sqrt(dx * dx + dy * dy) < 10) {
      selectedAircraft = plane;
      document.getElementById("selected-aircraft-info").innerHTML = `<p>${plane.callsign}</p>`;
      headingInput.value = plane.targetHdg;
      speedInput.value = plane.targetSpd;
      // CHANGED: Display the target altitude in the input box as a Flight Level.
      altitudeInput.value = plane.targetAlt / 100;
    }
  });
});

// --- Data Tag Repositioning (Right Click) ---
canvas.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  const rect = canvas.getBoundingClientRect();
  const mouseX = e.clientX - rect.left;
  const mouseY = e.clientY - rect.top;

  aircraftList.forEach((plane) => {
    // NEW: Get the plane's current pixel position for the click check.
    const { x, y } = latLonToPixel(plane.lat, plane.lon);
    const dx = x - mouseX;
    const dy = y - mouseY;
    if (Math.sqrt(dx * dx + dy * dy) < 10) {
      selectedAircraft = plane;
      plane.tagAngle += Math.PI / 4; // Cycle through 8 positions
      // Redraw immediately to show the change
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      displayedAircraft = aircraftList.map(p => Object.assign(new Aircraft(), p));
      displayedAircraft.forEach(plane => plane.draw());
    }
  });
});

// --- Command Input Handling ---
/**
 * A generic handler for the heading, speed, and altitude input fields.
 * It executes a given action when the Enter key is pressed.
 * @param {KeyboardEvent} event - The keydown event object.
 * @param {function} action - The function to call with the parsed input value.
 */
function handleCommandInput(event, action) {
  if (event.key === "Enter") {
    if (selectedAircraft) {
      const value = parseFloat(event.target.value);
      if (!isNaN(value)) {
        action(value); // e.g., call selectedAircraft.setHeading(value)
      }
    } else {
      console.log("No aircraft selected to give command to.");
    }
  }
}

// Assign the handler to each input field.
headingInput.addEventListener("keydown", (e) => {
  handleCommandInput(e, (val) => selectedAircraft.setHeading(val));
});

speedInput.addEventListener("keydown", (e) => {
  handleCommandInput(e, (val) => selectedAircraft.setSpeed(val));
});

altitudeInput.addEventListener("keydown", (e) => {
  handleCommandInput(e, (val) => selectedAircraft.setAltitude(val * 100));
});

// ================================================================================= //
//                                          APPLICATION START                        //
// ================================================================================= //

// 1. Define the geographic area.
calculateGeographicBounds();
// 2. Size the canvases to fit the window. This MUST happen before anything else.
resizeCanvas();

// NEW: Use the pixelToLatLon helper to set the initial positions.
// This ensures they start in the correct geographical spot.
const initialPos1 = pixelToLatLon(100, 100);
const initialPos2 = pixelToLatLon(700, 600);

aircraftList.push(new Aircraft("BAW123", initialPos1.lat, initialPos1.lon, 135, 18000, 230));
aircraftList.push(new Aircraft("AWE456", initialPos2.lat, initialPos2.lon, 225, 16000, 160));
displayedAircraft = aircraftList.map(p => Object.assign(new Aircraft(), p));
selectedAircraft = aircraftList[0];


// 3. Asynchronously load all nav data. This will trigger the one-time draw when complete.
loadNavData();
// 4. Start the main animation loop.
requestAnimationFrame(gameLoop);