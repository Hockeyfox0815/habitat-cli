import type { OutputWriters } from "./cli";

export type WorldScanProbability = {
  resourceType?: string;
  resource?: string;
  candidate?: string;
  probability?: number;
  chance?: number;
};

export type WorldScanQuantityEstimate = {
  resourceType?: string;
  candidateResource?: string;
  material?: string;
  kilograms?: number;
  estimatedKilograms?: number;
  estimatedValue?: number;
  minimumValue?: number;
  maximumValue?: number;
  minimumKilograms?: number;
  maximumKilograms?: number;
  exact?: boolean;
};

export type WorldScanTile = {
  x: number;
  y: number;
  distance?: number;
  distanceTiles?: number;
  terrain?: string;
  resourceProbabilities?: WorldScanProbability[];
  probabilities?: WorldScanProbability[];
  topCandidate?: WorldScanProbability | string | null;
  quantityEstimate?: WorldScanQuantityEstimate | null;
};

export type WorldScanResponse = {
  modelVersion?: string;
  origin?: {
    x: number;
    y: number;
  };
  sensorStrength?: number;
  radiusTiles?: number;
  tiles: WorldScanTile[];
};

type ScanRow = {
  x: string;
  y: string;
  distance: string;
  terrain: string;
  topCandidate: string;
  confidence: string;
  quantity: string;
};

type ScanColumn = {
  key: keyof ScanRow | "resource" | "probability";
  label: string;
};

function formatNumber(value: number) {
  if (!Number.isFinite(value)) {
    return "0";
  }

  const rounded = Number.parseFloat(value.toFixed(6));
  return `${rounded}`;
}

function formatPercent(value: number) {
  if (!Number.isFinite(value)) {
    return "0%";
  }

  return `${formatNumber(value)}%`;
}

function formatMaybeText(value: string | undefined | null) {
  return value && value.length > 0 ? value : "none";
}

function getTileDistance(tile: WorldScanTile) {
  if (typeof tile.distance === "number") {
    return tile.distance;
  }

  if (typeof tile.distanceTiles === "number") {
    return tile.distanceTiles;
  }

  return 0;
}

function getTileTerrain(tile: WorldScanTile) {
  return formatMaybeText(tile.terrain);
}

function getTileProbabilities(tile: WorldScanTile) {
  return tile.resourceProbabilities ?? tile.probabilities ?? [];
}

function getProbabilityName(probability: WorldScanProbability | string | null | undefined) {
  if (!probability) {
    return "none";
  }

  if (typeof probability === "string") {
    return probability;
  }

  return probability.resourceType ?? probability.resource ?? probability.candidate ?? "unknown";
}

function getProbabilityValue(probability: WorldScanProbability | string | null | undefined) {
  if (!probability || typeof probability === "string") {
    return 0;
  }

  const value = probability.probability ?? probability.chance ?? 0;
  return Number.isFinite(value) ? value : 0;
}

function getTopCandidate(tile: WorldScanTile) {
  return getProbabilityName(tile.topCandidate);
}

function getTopCandidateConfidence(tile: WorldScanTile) {
  const topProbability = getProbabilityValue(tile.topCandidate);
  return formatPercent(topProbability);
}

function getQuantityResource(estimate: WorldScanQuantityEstimate | null | undefined) {
  if (!estimate) {
    return "none";
  }

  return estimate.resourceType ?? estimate.candidateResource ?? estimate.material ?? "unknown";
}

function getQuantityKilograms(estimate: WorldScanQuantityEstimate | null | undefined) {
  if (!estimate) {
    return null;
  }

  if (typeof estimate.kilograms === "number") {
    return estimate.kilograms;
  }

  if (typeof estimate.estimatedKilograms === "number") {
    return estimate.estimatedKilograms;
  }

  return null;
}

function getQuantityRange(estimate: WorldScanQuantityEstimate | null | undefined) {
  if (!estimate) {
    return null;
  }

  const minimum = estimate.minimumKilograms ?? estimate.minimumValue;
  const maximum = estimate.maximumKilograms ?? estimate.maximumValue;

  if (typeof minimum !== "number" || typeof maximum !== "number") {
    return null;
  }

  return {
    minimum,
    maximum,
  };
}

function formatQuantityEstimate(estimate: WorldScanQuantityEstimate | null | undefined) {
  if (!estimate) {
    return "none";
  }

  const resource = getQuantityResource(estimate);
  const kilograms = getQuantityKilograms(estimate);
  const range = getQuantityRange(estimate);
  const estimatedValue =
    typeof estimate.estimatedValue === "number" ? `, value ${formatNumber(estimate.estimatedValue)}` : "";

  if (estimate.exact) {
    return `${resource} ${kilograms === null ? "?" : formatNumber(kilograms)} kg${estimatedValue}, exact`;
  }

  if (range) {
    return `${resource} ${kilograms === null ? "?" : formatNumber(kilograms)} kg${estimatedValue}, range ${formatNumber(range.minimum)}-${formatNumber(range.maximum)} kg`;
  }

  return `${resource} ${kilograms === null ? "?" : formatNumber(kilograms)} kg${estimatedValue}`;
}

function buildSummaryRows(response: WorldScanResponse): ScanRow[] {
  return response.tiles.map((tile) => ({
    x: `${tile.x}`,
    y: `${tile.y}`,
    distance: formatNumber(getTileDistance(tile)),
    terrain: getTileTerrain(tile),
    topCandidate: getTopCandidate(tile),
    confidence: getTopCandidateConfidence(tile),
    quantity: formatQuantityEstimate(tile.quantityEstimate),
  }));
}

function printBorderedTable(columns: ScanColumn[], rows: Array<Record<string, string>>, writers: OutputWriters) {
  const widths = columns.map((column) => Math.max(column.label.length, ...rows.map((row) => row[column.key].length)));
  const topBorder = `┌${widths.map((width) => "─".repeat(width + 2)).join("┬")}┐`;
  const headerDivider = `├${widths.map((width) => "─".repeat(width + 2)).join("┼")}┤`;
  const bottomBorder = `└${widths.map((width) => "─".repeat(width + 2)).join("┴")}┘`;

  writers.stdout(topBorder);
  writers.stdout(
    `│ ${columns.map((column, index) => column.label.padEnd(widths[index])).join(" │ ")} │`,
  );
  writers.stdout(headerDivider);

  rows.forEach((row, index) => {
    writers.stdout(`│ ${columns.map((column, index2) => row[column.key].padEnd(widths[index2])).join(" │ ")} │`);
    writers.stdout(index === rows.length - 1 ? bottomBorder : headerDivider);
  });
}

function printTileProbabilities(tile: WorldScanTile, writers: OutputWriters) {
  const rows = getTileProbabilities(tile).map((probability) => ({
    resource: getProbabilityName(probability),
    probability: formatPercent(getProbabilityValue(probability)),
  }));

  printBorderedTable(
    [
      { key: "resource", label: "Resource" },
      { key: "probability", label: "Probability" },
    ],
    rows,
    writers,
  );
}

export function printWorldScan(response: WorldScanResponse, writers: OutputWriters) {
  const tiles = response.tiles ?? [];
  const originX = response.origin?.x ?? 0;
  const originY = response.origin?.y ?? 0;
  const sensorStrength = typeof response.sensorStrength === "number" ? response.sensorStrength : 0;
  const radiusTiles = typeof response.radiusTiles === "number" ? response.radiusTiles : 0;

  writers.stdout(`Scan origin: (${originX}, ${originY})`);
  writers.stdout(`Sensor strength: ${formatNumber(sensorStrength)}`);
  writers.stdout(`Radius: ${radiusTiles}`);
  writers.stdout(`Tiles returned: ${tiles.length}`);

  if (tiles.length === 0) {
    writers.stdout("No scan tiles returned.");
    return;
  }

  if (tiles.length === 1) {
    const tile = tiles[0];
    writers.stdout(`Tile: (${tile.x}, ${tile.y})`);
    writers.stdout(`Distance: ${formatNumber(getTileDistance(tile))}`);
    writers.stdout(`Terrain: ${getTileTerrain(tile)}`);
    writers.stdout(`Top candidate: ${getTopCandidate(tile)} (${getTopCandidateConfidence(tile)})`);
    writers.stdout(`Estimated quantity: ${formatQuantityEstimate(tile.quantityEstimate)}`);
    writers.stdout("Probability distribution:");
    printTileProbabilities(tile, writers);
    return;
  }

  const rows = buildSummaryRows(response);
  printBorderedTable(
    [
      { key: "x", label: "X" },
      { key: "y", label: "Y" },
      { key: "distance", label: "Distance" },
      { key: "terrain", label: "Terrain" },
      { key: "topCandidate", label: "Top Candidate" },
      { key: "confidence", label: "Confidence" },
      { key: "quantity", label: "Quantity" },
    ],
    rows,
    writers,
  );
}

export function printWorldScanJson(response: WorldScanResponse, writers: OutputWriters) {
  writers.stdout(JSON.stringify(response, null, 2));
}
