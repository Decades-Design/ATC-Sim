// ================================================================================= //
//                                    UI & CANVAS GLOBALS                            //
// ================================================================================= //
const canvas = document.getElementById("radar-scope");
const ctx = canvas.getContext("2d");

const navdataCanvas = document.getElementById("navdata-canvas");
const navCtx = navdataCanvas.getContext("2d");
const canvasStack = document.getElementById("canvas-stack");

const tagInput = document.getElementById("tag-input");

// ================================================================================= //
//                                CORE SIMULATION CONFIGURATION                      //
// ================================================================================= //
const centerCoord = { lat: 45.44944444, lon: 9.27833333 }; // The geographical center of the radar scope.
const radarRangeNM = 30; // The distance from the center to the edge of the screen in nautical miles.

const activeAirports = {
  "LIML": ["RW35"],
  "LIMC": ["RW35R"]
};

const SWEEP_INTERVAL_MS = 2000;

// ================================================================================= //
//                            GEOGRAPHICAL HELPERS & CONSTANTS                       //
// ================================================================================= //
const NM_TO_KM = 1.852; // Nautical Miles to Kilometers conversion factor.
const KNOTS_TO_KPS = 0.000514444; // Knots (nautical miles per hour) to Kilometers Per Second.
const FEET_TO_KM = 0.0003048; // Feet to Kilometers.

let minLon, maxLon, minLat, maxLat;

/**
 * @summary Calculates the geographic bounding box for the simulation.
 * @description This defines the rectangular area for which navigation data will be queried, based on the center point and radar range. It's a simplified calculation that works best for areas not too close to the poles.
 */
function calculateGeographicBounds() {
    const radarRangeKm = radarRangeNM * NM_TO_KM;
    const centerLatRad = centerCoord.lat * Math.PI / 180;

    const latDelta = radarRangeKm / 111.32; // Approx 111.32 km per degree of latitude.
    const lonDelta = radarRangeKm / (111.32 * Math.cos(centerLatRad));

    minLat = centerCoord.lat - latDelta;
    maxLat = centerCoord.lat + latDelta;
    minLon = centerCoord.lon - lonDelta;
    maxLon = centerCoord.lon + lonDelta;
}


// ================================================================================= //
//                                GLOBAL SIMULATION STATE                            //
// ================================================================================= //
let aircraftList = []; // The master list of all aircraft currently in the simulation.
let navDataPoints = []; // Holds all en-route waypoints loaded from the database.
let vorData = []; // Holds all VOR navaids loaded from the database.
let airports = []; // Holds all airport data loaded from the database.
let terminalWaypoints = []; // Holds all terminal waypoints (SIDs/STARs) loaded from the database.
let runways = []; // Holds all runway data loaded from the database.
let ilsData = []; // Holds all ILS (localizer/glideslope) data loaded from the database.
let approachPaths = []; // Holds all instrument approach procedure data.
let selectedAircraft = null; // The aircraft currently selected by the user for command input.
let hoveredAircraft = null; // The aircraft currently being hovered over by the mouse.
let radarRadius; // The radius of the radar scope in pixels, calculated on resize.
let kmPerPixel; // The ratio of kilometers to pixels, used for converting real-world distances to screen distances.

// ================================================================================= //
//                                TIMING & ANIMATION STATE                           //
// ================================================================================= //
let lastUpdateTime = 0; // The timestamp of the last frame update, used to calculate delta time.
let timeSinceLastSweep = 0; // Time accumulator for the radar sweep effect.

// ================================================================================= //
//                                     AIRCRAFT CLASS                                //
// ================================================================================= //
class Aircraft {
  /**
   * @summary Represents a single aircraft in the simulation.
   * @param {string} callsign - The aircraft's unique identifier (e.g., "BAW123").
   * @param {number} lat - The initial latitude in decimal degrees.
   * @param {number} lon - The initial longitude in decimal degrees.
   * @param {number} heading - The initial heading in degrees (0-360).
   * @param {number} altitude - The initial altitude in feet.
   * @param {number} speed - The initial speed in knots.
   * @param {string} destination - The flight's destination airport ICAO code (e.g., "LIMC").
   * @param {string} wtc - The wake turbulence category ("L", "M", "H").
   * @param {number} [tagAngle=0] - The initial angle for the data tag, in radians.
   */
  constructor(callsign, lat, lon, heading, altitude, speed, destination, wtc, tagAngle) {
    this.callsign = callsign;
    this.lat = lat;
    this.lon = lon;
    this.destination = destination;
    this.wtc = wtc;
    this.scratchpad = "SCRATCHPAD";
    this.verticalSpeed = 0; // Vertical speed in feet per minute.

    // Convert initial lat/lon to pixel coordinates for immediate display.
    const { x, y } = latLonToPixel(this.lat, this.lon);
    this.displayX = x; // The X coordinate used for rendering (updates with radar sweep).
    this.displayY = y; // The Y coordinate used for rendering (updates with radar sweep).
    
    this.displayHdg = heading; // The heading used for rendering.
    this.heading = heading; // The aircraft's current actual heading.
    this.targetHdg = heading; // The heading assigned by the controller.
    this.altitude = altitude; // The aircraft's current actual altitude.
    this.targetAlt = altitude; // The altitude assigned by the controller.
    this.speed = speed; // The aircraft's current actual speed.
    this.targetSpd = speed; // The speed assigned by the controller.
    this.tagAngle = tagAngle || 0; // The angle of the data tag relative to the aircraft symbol.
  }


  /**
   * @summary Updates the aircraft's position and flight parameters based on elapsed time.
   * @param {number} deltaTime - The time in seconds since the last update.
   */
  update(deltaTime) {
    // --- 1. HEADING INTERPOLATION ---
    if (this.heading !== this.targetHdg) {
        const turnRate = 2; // Aircraft turn rate in degrees per second.
        const turnStep = turnRate * deltaTime;
        
        let diff = this.targetHdg - this.heading;
        if (diff > 180) diff -= 360;
        if (diff < -180) diff += 360;

        if (Math.abs(diff) < turnStep) {
            this.heading = this.targetHdg;
        } else {
            this.heading += turnStep * Math.sign(diff);
        }
        this.heading = ((this.heading % 360) + 360) % 360;
    }

    // --- 2. SPEED INTERPOLATION ---
    if (this.speed !== this.targetSpd) {
        const accel = 10; // Aircraft acceleration/deceleration in knots per second.
        const speedStep = accel * deltaTime;

        if (Math.abs(this.targetSpd - this.speed) < speedStep) {
            this.speed = this.targetSpd;
        } else {
            this.speed += speedStep * Math.sign(this.targetSpd - this.speed);
        }
    }

    // --- 3. ALTITUDE INTERPOLATION ---
    if (this.altitude !== this.targetAlt) {
        const verticalSpeedFPM = 1500; // Standard climb/descent rate in feet per minute.
        const verticalSpeedFPS = verticalSpeedFPM / 60;
        const altStep = verticalSpeedFPS * deltaTime;

        if (Math.abs(this.targetAlt - this.altitude) < altStep) {
            this.altitude = this.targetAlt;
            this.verticalSpeed = 0;
        } else {
            const direction = Math.sign(this.targetAlt - this.altitude);
            this.altitude += altStep * direction;
            this.verticalSpeed = verticalSpeedFPM * direction;
        }
    } else {
        this.verticalSpeed = 0;
    }

    // --- 4. GEOGRAPHICAL POSITION UPDATE ---
    const speedInKps = this.speed * KNOTS_TO_KPS;
    const distanceMovedKm = speedInKps * deltaTime;
    const bearingRad = this.heading * Math.PI / 180;
    const latRad = this.lat * Math.PI / 180;
    const R = 6371; // Earth's mean radius in kilometers.

    const newLatRad = Math.asin(Math.sin(latRad) * Math.cos(distanceMovedKm / R) +
      Math.cos(latRad) * Math.sin(distanceMovedKm / R) * Math.cos(bearingRad));
    const newLonRad = (this.lon * Math.PI / 180) + Math.atan2(Math.sin(bearingRad) * Math.sin(distanceMovedKm / R) * Math.cos(latRad),
      Math.cos(distanceMovedKm / R) - Math.sin(latRad) * Math.sin(newLatRad));

    this.lat = newLatRad * 180 / Math.PI;
    this.lon = newLonRad * 180 / Math.PI;
  }

  /**
   * @summary Draws the aircraft symbol, vector line, and data tag on the canvas.
   * @param {boolean} [isHovered=false] - True if the mouse is hovering over the aircraft's tag, triggering the detailed view.
   */
  draw(isHovered = false) {
    const x = this.displayX;
    const y = this.displayY;

    ctx.beginPath();
    ctx.arc(x, y, 4, 0, 2 * Math.PI);
    ctx.fillStyle = "#0f0";
    ctx.fill();
    const lineTimeLength = 60; // The vector line represents 60 seconds of travel at current speed.
    const speedInKps = this.speed * KNOTS_TO_KPS;
    const distanceKm = speedInKps * lineTimeLength;
    const lineLength = distanceKm / kmPerPixel;
    const rad = (this.displayHdg * Math.PI) / 180;
    const endX = x + Math.sin(rad) * lineLength;
    const endY = y - Math.cos(rad) * lineLength;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(endX, endY);
    ctx.strokeStyle = "#0f0";
    ctx.lineWidth = 2;
    ctx.stroke();

    const layout = calculateTagLayout(this, isHovered);
    ctx.font = '11px "Google Sans Code"';
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";

    if (isHovered) {
        ctx.fillStyle = "rgba(30, 30, 30, 0.9)";
        ctx.fillRect(
            layout.anchor.x - (layout.block.width / 2) - layout.padding,
            layout.anchor.y - (layout.block.height / 2) - layout.padding,
            layout.block.width + (layout.padding * 2),
            layout.block.height + (layout.padding * 2)
        );
        ctx.fillStyle = "#0f0";
    }

    if (isHovered) {
        ctx.fillText(layout.lines[0].text, layout.tagOriginX, layout.anchor.y - layout.lineHeight * 1.5);
        ctx.fillText(layout.lines[1].text, layout.tagOriginX, layout.anchor.y - layout.lineHeight * 0.5);
        ctx.fillText(layout.lines[2].text, layout.tagOriginX, layout.anchor.y + layout.lineHeight * 0.5);
        ctx.fillText(layout.lines[3].text, layout.tagOriginX, layout.anchor.y + layout.lineHeight * 1.5);
    } else {
        ctx.fillText(layout.lines[0].text, layout.tagOriginX, layout.anchor.y - layout.lineHeight);
        ctx.fillText(layout.lines[1].text, layout.tagOriginX, layout.anchor.y);
        ctx.fillText(layout.lines[2].text, layout.tagOriginX, layout.anchor.y + layout.lineHeight);
    }
  }

  /**
   * @summary Sets the new target heading for the aircraft.
   * @param {number} newHeading - The desired heading in degrees (0-360).
   */
  setHeading(newHeading) {
    this.targetHdg = ((newHeading % 360) + 360) % 360; // Normalize to ensure it's within the 0-360 range.
  }

  /**
   * @summary Sets the new target speed for the aircraft.
   * @param {number} newSpeed - The desired speed in knots.
   */
  setSpeed(newSpeed) {
    this.targetSpd = Math.max(100, newSpeed); // Enforce a minimum speed to prevent unrealistic scenarios.
  }

  /**
   * @summary Sets the new target altitude for the aircraft.
   * @param {number} newAltitude - The desired altitude in feet.
   */
  setAltitude(newAltitude) {
    this.targetAlt = newAltitude;
  }
}

// ================================================================================= //
//                         COORDINATE CONVERSION & CANVAS SIZING                     //
// ================================================================================= //

/**
 * @summary Converts screen pixel coordinates to geographical coordinates.
 * @param {number} x - The x-pixel coordinate on the canvas.
 * @param {number} y - The y-pixel coordinate on the canvas.
 * @returns {{lat: number, lon: number}} The corresponding latitude and longitude.
 */
function pixelToLatLon(x, y) {
  const lon = (x / navdataCanvas.width) * (maxLon - minLon) + minLon;
  const lat = maxLat - (y / navdataCanvas.height) * (maxLat - minLat); // Y is inverted because screen coordinates start at the top.
  return { lat, lon };
}

/**
 * @summary Converts geographical coordinates to screen pixel coordinates.
 * @param {number} lat - The latitude to convert.
 * @param {number} lon - The longitude to convert.
 * @returns {{x: number, y: number}} The corresponding x and y pixel coordinates on the canvas.
 */
function latLonToPixel(lat, lon) {
  const x = ((lon - minLon) / (maxLon - minLon)) * navdataCanvas.width;
  const y = ((maxLat - lat) / (maxLat - minLat)) * navdataCanvas.height; // Y is inverted.
  return { x, y };
}

/**
 * @summary Resizes the canvas elements to fit the window while maintaining a 1:1 aspect ratio.
 */
function resizeCanvas() {
  const padding = 20;
  const availableWidth = window.innerWidth - padding;
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

// ================================================================================= //
//                            DATA TAG & AIRCRAFT RENDERING                          //
// ================================================================================= //

/**
 * @summary Calculates the layout, dimensions, and positions for an aircraft's data tag.
 * @param {Aircraft} plane - The aircraft for which to calculate the tag layout.
 * @param {boolean} isHovered - Whether the tag should be in the detailed (hovered) state.
 * @returns {object} An object containing all necessary layout information (positions, sizes, hitboxes).
 */
function calculateTagLayout(plane, isHovered) {
    ctx.font = '11px "Google Sans Code"';
    const lineHeight = 15;
    const padding = 3;

    // --- 1. Prepare Text Content ---
    const assignedHdg = `H${Math.round(plane.targetHdg).toString().padStart(3, '0')}`;
    const line1 = { text: `${plane.callsign} ${assignedHdg}` };

    const currentFL = Math.round(plane.altitude / 100).toString().padStart(3, '0');
    let trendIndicator = " ";
    if (Math.abs(plane.targetAlt - plane.altitude) > 50) {
        trendIndicator = plane.targetAlt > plane.altitude ? "↑" : "↓";
    }
    const crcVal = Math.round(plane.verticalSpeed / 100);
    const crcText = `${crcVal > 0 ? '+' : ''}${crcVal.toString().padStart(2, '0')}`;
    const line2 = { 
      text: isHovered 
        ? `${currentFL}${trendIndicator} ${plane.destination} XX ${crcText}`
        : `${currentFL}${trendIndicator} ${plane.destination}`
    };
    
    const clearedFL = Math.round(plane.targetAlt / 100).toString().padStart(3, '0');
    const speedWTC = `${Math.round(plane.speed)}${plane.wtc}`;
    const line3 = { text: `${speedWTC} ${clearedFL}` };
    
    const line4 = { text: plane.scratchpad };

    const lines = isHovered ? [line1, line2, line3, line4] : [line1, line2, line3];
    lines.forEach(line => line.width = ctx.measureText(line.text).width);

    // --- 2. Calculate Block Dimensions ---
    const blockWidth = Math.max(...lines.map(line => line.width));
    const blockHeight = lineHeight * lines.length;
    
    // --- 3. Calculate Positions ---
    const TAG_GAP = 15;
    const radiusX = (blockWidth / 2) + TAG_GAP + padding;
    const radiusY = (blockHeight / 2) + TAG_GAP + padding;
    const anchor = {
        x: plane.displayX + radiusX * Math.cos(plane.tagAngle),
        y: plane.displayY + radiusY * Math.sin(plane.tagAngle)
    };
    const tagOriginX = anchor.x - (blockWidth / 2);

    // --- 4. Calculate Hitboxes ---
    const callsignText = `${plane.callsign} `;
    const speedWTCText = `${Math.round(plane.speed)}${plane.wtc}`;
    const clearedFLText = ` ${Math.round(plane.targetAlt / 100).toString().padStart(3, '0')}`;

    const headingWidth = ctx.measureText(assignedHdg).width;
    const headingX = tagOriginX + ctx.measureText(callsignText).width;
    const speedWidth = ctx.measureText(speedWTCText).width;
    const altitudeWidth = ctx.measureText(clearedFLText).width;
    const altitudeX = tagOriginX + ctx.measureText(speedWTCText).width;
    
    const hitboxes = {
        heading: { 
            x: headingX, 
            y: isHovered ? anchor.y - lineHeight * 1.5 : anchor.y - lineHeight, 
            width: headingWidth,  
            height: lineHeight 
        },
        speed: { 
            x: tagOriginX,
            y: isHovered ? anchor.y + lineHeight * 0.5 : anchor.y + lineHeight, 
            width: speedWidth,    
            height: lineHeight 
        },
        altitude: { 
            x: altitudeX, 
            y: isHovered ? anchor.y + lineHeight * 0.5 : anchor.y + lineHeight, 
            width: altitudeWidth, 
            height: lineHeight 
        }
    };

    return { lines, block: { width: blockWidth, height: blockHeight }, anchor, tagOriginX, hitboxes, padding, lineHeight };
}

/**
 * @summary Gets the bounding box for the entire data tag, used for hover detection.
 * @param {Aircraft} plane - The aircraft whose tag bounding box is needed.
 * @returns {{x: number, y: number, width: number, height: number}} The bounding box.
 */
function getAircraftTagBoundingBox(plane) {
    const layout = calculateTagLayout(plane, hoveredAircraft === plane);
    return {
        x: layout.anchor.x - (layout.block.width / 2) - layout.padding,
        y: layout.anchor.y - (layout.block.height / 2) - layout.padding,
        width: layout.block.width + (layout.padding * 2),
        height: layout.block.height + (layout.padding * 2)
    };
}

/**
 * @summary Gets the specific hitboxes for clickable elements within a data tag.
 * @param {Aircraft} plane - The aircraft whose hitboxes are needed.
 * @returns {object} An object containing hitboxes for "heading", "speed", and "altitude".
 */
function getTagHitboxes(plane) {
    const layout = calculateTagLayout(plane, true);
    return layout.hitboxes;
}

// ================================================================================= //
//                          NAVIGATIONAL AID & MAP RENDERING                         //
// ================================================================================= //

/**
 * @summary Draws a hexagonal VOR symbol.
 * @param {CanvasRenderingContext2D} ctx - The canvas rendering context.
 * @param {number} x - The center x-coordinate of the symbol.
 * @param {number} y - The center y-coordinate of the symbol.
 * @param {number} size - The radius of the symbol.
 */
function drawVorSymbol(ctx, x, y, size) {
  ctx.beginPath();
  ctx.moveTo(x + size * Math.cos(0), y + size * Math.sin(0));
  for (let i = 1; i <= 6; i++) {
    const angle = i * Math.PI / 3;
    ctx.lineTo(x + size * Math.cos(angle), y + size * Math.sin(angle));
  }
  ctx.strokeStyle = "rgba(255, 255, 255, 0.75)";
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(x, y, 1.5, 0, 2 * Math.PI); // Center dot
  ctx.fillStyle = "rgba(255, 255, 255, 0.75)";
  ctx.fill();
}

/**
 * @summary Draws a single waypoint symbol (triangle or star) and its name.
 * @param {CanvasRenderingContext2D} ctx - The canvas rendering context.
 * @param {object} point - The waypoint object from the database.
 */
function drawWaypointSymbol(ctx, point) {
  const { x, y } = latLonToPixel(point.lat, point.lon);

  if (point.type[0] === 'C' || point.type[0] === 'R') {
    const size = 6;
    ctx.beginPath();
    ctx.moveTo(x, y - size * 0.75);
    ctx.lineTo(x - size * 0.6, y + size * 0.45);
    ctx.lineTo(x + size * 0.6, y + size * 0.45);
    ctx.closePath();
    ctx.fill();
  } else if (point.type[0] === 'W') {
    const size = 5;
    const innerSize = size / 2.5;
    ctx.beginPath();
    ctx.moveTo(x, y - size);
    ctx.lineTo(x + innerSize, y - innerSize);
    ctx.lineTo(x + size, y);
    ctx.lineTo(x + innerSize, y + innerSize);
    ctx.lineTo(x, y + size);
    ctx.lineTo(x - innerSize, y + innerSize);
    ctx.lineTo(x - size, y);
    ctx.lineTo(x - innerSize, y - innerSize);
    ctx.closePath();
    ctx.fill();
  }

  if (!/\d/.test(point.name)) {
    ctx.fillText(point.name, x + 8, y);
  }
}

/**
 * @summary Draws all runways for the currently active airports.
 * @param {CanvasRenderingContext2D} ctx - The canvas rendering context.
 */
function drawAllRunways(ctx) {
  const drawnRunways = new Set();
  runways.forEach(runway => {
    if (activeAirports[runway.airport] && activeAirports[runway.airport].includes(runway.id) && !drawnRunways.has(runway.id)) {
      const p1 = latLonToPixel(runway.lat, runway.lon);
      let p2;

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
        p2 = latLonToPixel(oppositeRunway.lat, oppositeRunway.lon);
        drawnRunways.add(oppositeRunway.id);
      } else {
        const lengthPx = (runway.length * FEET_TO_KM) / kmPerPixel;
        const bearingRad = runway.trueBearing * Math.PI / 180;
        p2 = { x: p1.x + Math.sin(bearingRad) * lengthPx, y: p1.y - Math.cos(bearingRad) * lengthPx };
      }

      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
      ctx.strokeStyle = "rgba(255, 255, 255, 1)";
      ctx.lineWidth = 4;
      ctx.stroke();
      drawnRunways.add(runway.id);
    }
  });
}

/**
 * @summary Draws all ILS (Instrument Landing System) localizer lines for active runways.
 * @param {CanvasRenderingContext2D} ctx - The canvas rendering context.
 */
function drawAllIls(ctx) {
  ilsData.forEach(ils => {
    if (activeAirports[ils.airport] && activeAirports[ils.airport].includes(ils.runway)) {
      const runway = runways.find(r => r.id === ils.runway && r.airport === ils.airport);
      if (!runway) return;

      const threshold = latLonToPixel(runway.lat, runway.lon);
      const trueBearing = ils.bearing + ils.declination;
      const bearingRad = trueBearing * Math.PI / 180;
      
      const locLengthPx = (15 * NM_TO_KM) / kmPerPixel;

      const endX = threshold.x - Math.sin(bearingRad) * locLengthPx;
      const endY = threshold.y + Math.cos(bearingRad) * locLengthPx;

      ctx.beginPath();
      ctx.moveTo(threshold.x, threshold.y);
      ctx.lineTo(endX, endY);
      ctx.strokeStyle = "rgba(156, 156, 106, 1)";
      ctx.lineWidth = 3;
      ctx.stroke();
    }
  });
}

/**
 * @summary Draws all en-route and terminal waypoints on the map.
 * @param {CanvasRenderingContext2D} ctx - The canvas rendering context.
 */
function drawAllWaypoints(ctx) {
  ctx.fillStyle = "rgba(255, 255, 255, 0.75)";
  ctx.font = '11px "Courier New"';
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  navDataPoints.forEach(point => drawWaypointSymbol(ctx, point));
  terminalWaypoints.forEach(point => {
    if (activeAirports[point.airport] && !/\d/.test(point.name)) {
      drawWaypointSymbol(ctx, point);
    }
  });
}

/**
 * @summary Draws all VOR navaids on the map.
 * @param {CanvasRenderingContext2D} ctx - The canvas rendering context.
 */
function drawAllVors(ctx) {
  vorData.forEach(vor => {
    const size = 5;
    const { x, y } = latLonToPixel(vor.lat, vor.lon);
    drawVorSymbol(ctx, x, y, size);
    ctx.fillText(vor.id, x + 8, y);
    if (vor.type[1] === 'D') {
      const boxSize = size * 2.5;
      ctx.strokeStyle = "rgba(255, 255, 255, 0.75)";
      ctx.lineWidth = 1.5;
      ctx.strokeRect(x - boxSize / 2, y - boxSize / 2, boxSize, boxSize);
    }
  });
}

/**
 * @summary Main function to draw all static navigation data onto its dedicated canvas.
 */
function drawNavData() {
  navCtx.clearRect(0, 0, navdataCanvas.width, navdataCanvas.height);
  drawAllRunways(navCtx);
  drawAllIls(navCtx);
  drawAllWaypoints(navCtx);
  drawAllVors(navCtx);
}

// ================================================================================= //
//                                     MAIN GAME LOOP                                //
// ================================================================================= //
/**
 * @summary The main animation loop that updates and redraws the simulation every frame.
 * @param {number} currentTime - The current time provided by `requestAnimationFrame`.
 */
function gameLoop(currentTime) {
  if (lastUpdateTime === 0) {
    lastUpdateTime = currentTime;
  }
  const deltaTimeMs = currentTime - lastUpdateTime;
  lastUpdateTime = currentTime;

  aircraftList.forEach(plane => plane.update(deltaTimeMs / 1000));

  timeSinceLastSweep += deltaTimeMs;
  if (timeSinceLastSweep >= SWEEP_INTERVAL_MS) {
    aircraftList.forEach(plane => {
        const { x, y } = latLonToPixel(plane.lat, plane.lon);
        plane.displayX = x;
        plane.displayY = y;
        plane.displayHdg = plane.heading; 
    });
    timeSinceLastSweep = 0;
  }

  if (activeInput) {
    const isPlaneHovered = activeInput.plane === hoveredAircraft;
    const layout = calculateTagLayout(activeInput.plane, isPlaneHovered);
    const box = layout.hitboxes[activeInput.property];
    if (box) {
      tagInput.style.left = `${box.x}px`;
      tagInput.style.top = `${box.y - box.height / 2}px`;
    }
  }

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  
  aircraftList.forEach(plane => plane.draw(plane === hoveredAircraft));

  requestAnimationFrame(gameLoop);
}

// ================================================================================= //
//                                NAVIGATION DATABASE                               //
// ================================================================================= //

/**
 * @summary A helper function to execute a SQL query and map the results to an array of objects.
 * @param {Database} db - The SQL.js database object.
 * @param {string} sql - The SQL query string to execute.
 * @param {function} mapper - A function that maps a result row to an object.
 * @returns {Array} An array of objects created by the mapper function.
 */
function queryAndMap(db, sql, mapper) {
    const result = db.exec(sql);
    if (result.length > 0 && result[0].values.length > 0) {
        return result[0].values.map(mapper);
    }
    return []; // Return an empty array if there are no results.
}

/**
 * @summary Initializes the SQL.js database and loads all necessary navigation data within the geographic bounds.
 */
function loadNavData() {
  const wasmPath = 'node_modules/sql.js/dist/sql-wasm.wasm';
  const dbPath = 'NavData/navdb.s3db';

  initSqlJs({ locateFile: () => wasmPath })
    .then(SQL => {
      return fetch(dbPath)
        .then(response => response.arrayBuffer())
        .then(filebuffer => {
          const dbObject = new SQL.Database(new Uint8Array(filebuffer));

          navDataPoints = queryAndMap(dbObject, `
            SELECT * FROM main.tbl_enroute_waypoints 
            WHERE waypoint_longitude BETWEEN ${minLon} AND ${maxLon} AND waypoint_latitude BETWEEN ${minLat} AND ${maxLat}
            AND waypoint_identifier NOT LIKE 'VP%' AND waypoint_type != 'U'`,
            row => ({ name: row[2], type: row[4], lon:  row[7], lat:  row[6] })
          );

          airports = queryAndMap(dbObject, `
            SELECT * FROM tbl_airports 
            WHERE airport_ref_longitude BETWEEN ${minLon} AND ${maxLon} AND airport_ref_latitude BETWEEN ${minLat} AND ${maxLat} AND ifr_capability = 'Y'`,
            row => ({ icao: row[2], name: row[4], lon: row[6], lat: row[5], TA: row[10], TL: row[11], elevation: row[9] })
          );

          vorData = queryAndMap(dbObject, `
            SELECT * FROM main.tbl_vhfnavaids 
            WHERE vor_longitude BETWEEN ${minLon} AND ${maxLon} AND vor_latitude BETWEEN ${minLat} AND ${maxLat} AND navaid_class like 'V%'`,
            row => ({ id: row[3], name: row[4], type: row[6], lon: row[8], lat: row[7] })
          );

          terminalWaypoints = queryAndMap(dbObject, `
            SELECT * FROM tbl_terminal_waypoints
            WHERE waypoint_longitude BETWEEN ${minLon} AND ${maxLon} AND waypoint_latitude BETWEEN ${minLat} AND ${maxLat} AND waypoint_identifier NOT LIKE 'VP%'`,
            row => ({ name: row[3], airport: row[1], type: row[5], lon: row[7], lat: row[6] })
          );

          runways = queryAndMap(dbObject, `
            SELECT * FROM tbl_runways
            WHERE runway_longitude BETWEEN ${minLon} AND ${maxLon} AND runway_latitude BETWEEN ${minLat} AND ${maxLat}`,
            row => ({ id: row[3], airport: row[2], lon: row[5], lat: row[4], length: row[12], width: row[13], thrElevation: row[9], thrXelevation: row[11], magBearing: row[7], trueBearing: row[8] })
          );

          ilsData = queryAndMap(dbObject, `
            SELECT * FROM tbl_localizers_glideslopes
            WHERE llz_longitude BETWEEN ${minLon} AND ${maxLon} AND llz_latitude BETWEEN ${minLat} AND ${maxLat}`,
            row => ({ airport: row[2], runway: row[3], id: row[4], type: row[10], lon: row[6], lat: row[5], bearing: row[8], width: row[9], gsLat: row[11], gsLon: row[12], gsAngle: row[13], gsElevation: row[14], declination: row[15] })
          );
          
          const icaoListForSQL = airports.map(a => `'${a.icao}'`).join(',');
          if (icaoListForSQL) {
            approachPaths = queryAndMap(dbObject, `
              SELECT * FROM tbl_iaps WHERE airport_identifier IN (${icaoListForSQL})`,
              row => ({ icao: row[1], id: row[2], routeType: row[3], transitionId: row[4], seqno: row[5], waypointId: row[7], waypointLat: row[8], waypointLon: row[9], waypointType: row[10], turnDirection: row[11], pathTerm: row[13], navaid: row[14], navaidLat: row[15], navaidLon: row[16], arcRadius: row[17], theta: row[18], rho: row[19], magCourse: row[20], routeHoldDistanceTime: row[21], distanceOrTime: row[22], altitudeDescription: row[23], altitude1: row[24], altitude2: row[25], transitionAlt: row[26], speedLimitDescription: row[27], speedLimit: row[28], verticalAngle: row[29] })
            );
          }

          dbObject.close();
          drawNavData();
        });
    })
    .catch(err => {
      console.error("Database loading failed:", err);
    });
}

// ================================================================================= //
//                               USER INPUT & EVENT HANDLING                         //
// ================================================================================= //
window.addEventListener("resize", resizeCanvas);
canvas.addEventListener("contextmenu", (e) => e.preventDefault());

let activeInput = null;

/**
 * @summary Shows and positions the tag input box over the correct element.
 * @param {Aircraft} plane - The plane being edited.
 * @param {string} property - The property to be edited: "heading", "speed", or "altitude".
 * @param {object} hitbox - The hitbox object from the layout calculation, used for positioning.
 */
function showTagInput(plane, property, hitbox) {
    activeInput = { plane, property };
    
    tagInput.style.display = 'block';
    tagInput.style.left = `${hitbox.x}px`;
    tagInput.style.top = `${hitbox.y - hitbox.height / 2}px`;
    tagInput.style.width = `${hitbox.width}px`;
    tagInput.style.height = `${hitbox.height}px`;

    if (property === 'heading') tagInput.value = plane.targetHdg;
    if (property === 'speed') tagInput.value = plane.targetSpd;
    if (property === 'altitude') tagInput.value = plane.targetAlt / 100;

    tagInput.focus();
    tagInput.select();
}

// --- Main Click Listener for Data Tag Interaction ---
canvas.addEventListener('click', (e) => {
    if (activeInput) {
        tagInput.style.display = 'none';
        activeInput = null;
        return;
    }
    
    const rect = canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    for (const plane of aircraftList) {
        const hitboxes = getTagHitboxes(plane);
        
        for (const property in hitboxes) {
            const box = hitboxes[property];
            if (mouseX > box.x && mouseX < box.x + box.width &&
                mouseY > box.y - box.height / 2 && mouseY < box.y + box.height / 2)
            {
                showTagInput(plane, property, box);
                return;
            }
        }
    }
});


// --- Event Listener for the Pop-up Input Field ---
tagInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        if (activeInput) {
            const value = parseFloat(tagInput.value);
            if (!isNaN(value)) {
                const { plane, property } = activeInput;
                if (property === 'heading') plane.setHeading(value);
                if (property === 'speed') plane.setSpeed(value);
                if (property === 'altitude') plane.setAltitude(value * 100);
            }
        }
        tagInput.blur();
    }
    if (e.key === 'Escape') {
        tagInput.blur();
    }
});

// --- Real-time validation for the Pop-up Input Field ---
tagInput.addEventListener('input', () => {
    // Remove any character that is not a digit.
    tagInput.value = tagInput.value.replace(/[^0-9]/g, '');

    // Enforce a 3-digit limit, which is standard for these inputs.
    if (tagInput.value.length > 3) {
        tagInput.value = tagInput.value.slice(0, 3);
    }
});


// --- Hides the input field when it loses focus ---
tagInput.addEventListener('blur', () => {
    tagInput.style.display = 'none';
    activeInput = null;
});

// --- Mouse Hover Detection for Data Tags ---
canvas.addEventListener('mousemove', (e) => {
    const rect = canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    let foundAircraft = null;
    for (let i = aircraftList.length - 1; i >= 0; i--) {
        const plane = aircraftList[i];
        const bounds = getAircraftTagBoundingBox(plane);
        if (mouseX > bounds.x && mouseX < bounds.x + bounds.width &&
            mouseY > bounds.y && mouseY < bounds.y + bounds.height) {
            foundAircraft = plane;
            break;
        }
    }
    hoveredAircraft = foundAircraft;
});

// --- Data Tag Repositioning (via Right Click on aircraft symbol) ---
canvas.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  const rect = canvas.getBoundingClientRect();
  const mouseX = e.clientX - rect.left;
  const mouseY = e.clientY - rect.top;

  aircraftList.forEach((plane) => {
    const dx = plane.displayX - mouseX;
    const dy = plane.displayY - mouseY;
    if (Math.sqrt(dx * dx + dy * dy) < 15) {
      plane.tagAngle += Math.PI / 3;
    }
  });
});

// ================================================================================= //
//                                     INITIALIZATION                                //
// ================================================================================= //

// 1. Define the geographic area for the simulation.
calculateGeographicBounds();
// 2. Size the canvases to fit the window. This MUST happen before any data is drawn.
resizeCanvas();

// 3. Create some initial aircraft for testing purposes.
// Use pixelToLatLon to place them at specific screen locations initially.
const initialPos1 = pixelToLatLon(100, 100);
const initialPos2 = pixelToLatLon(700, 600);

aircraftList.push(new Aircraft("BAW123", initialPos1.lat, initialPos1.lon, 135, 18000, 230, "LIMC", "M"));
aircraftList.push(new Aircraft("AWE456", initialPos2.lat, initialPos2.lon, 225, 16000, 160, "LIML", "M"));
selectedAircraft = aircraftList[0];


// 4. Asynchronously load all nav data. This will trigger the one-time map draw when complete.
loadNavData();
// 5. Start the main animation loop.
requestAnimationFrame(gameLoop);