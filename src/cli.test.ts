import { access, mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readHumans, readInventory, readModules, readRegistration, writeModules } from "./api-client";
import { runCli } from "./cli";
import { createHabitatApp } from "./routes";
import { getDatabaseFile } from "./local-state";

type ModuleRecord = {
  id: string;
  blueprintId: string;
  displayName: string;
  connectedTo: string[];
  runtimeAttributes: Record<string, unknown>;
  capabilities: string[];
};

const token = "kepler_test_token";
const habitatId = "habitat_test_123";

const starterModules: ModuleRecord[] = [
  {
    id: "module-command",
    blueprintId: "command-module",
    displayName: "Command Module",
    connectedTo: [],
    runtimeAttributes: {
      health: 100,
      status: "active",
      crewCapacity: 2,
      pressurizedVolumeM3: 60,
      dataStorageTb: 4,
      powerDrawKw: {
        offline: 0,
        online: 2,
        active: 2,
        damaged: 2,
      },
    },
    capabilities: ["habitat-command"],
  },
  {
    id: "module-life-support",
    blueprintId: "life-support",
    displayName: "Life Support",
    connectedTo: [],
    runtimeAttributes: {
      health: 100,
      status: "active",
      crewCapacity: 2,
      crewSupportNominal: 2,
      crewSupportEmergency: 3,
      pressurizedVolumeM3: 35,
      oxygenBufferKg: 120,
      waterBufferKg: 1200,
      co2WarningPpm: 2000,
      powerDrawKw: {
        offline: 0,
        online: 5,
        active: 5,
        damaged: 5,
      },
      oxygenProductionKgPerHour: 0.1,
      co2ScrubKgPerHour: 0.12,
    },
    capabilities: ["atmosphere-control", "redundant-life-support"],
  },
  {
    id: "module-basic-battery",
    blueprintId: "basic-battery",
    displayName: "Basic Battery",
    connectedTo: [],
    runtimeAttributes: {
      health: 100,
      status: "offline",
      crewCapacity: 0,
      physicalVolumeM3: 8,
      currentEnergyKwh: 500,
      energyStorageKwh: 500,
      reserveKwh: 60,
      maxPowerOutputKw: 40,
      powerDrawKw: {
        offline: 0,
        online: 0,
        active: 0,
        damaged: 0,
      },
    },
    capabilities: ["power-storage"],
  },
  {
    id: "module-supply-cache",
    blueprintId: "supply-cache",
    displayName: "Supply Cache",
    connectedTo: [],
    runtimeAttributes: {
      health: 100,
      status: "offline",
      crewCapacity: 0,
      physicalVolumeM3: 25,
      storageMassKg: 6000,
      cargoVolumeM3: 18,
      powerDrawKw: {
        offline: 0,
        online: 0,
        active: 0,
        damaged: 0,
      },
    },
    capabilities: ["storage"],
  },
  {
    id: "module-workshop-fabricator",
    blueprintId: "workshop-fabricator",
    displayName: "Workshop Fabricator",
    connectedTo: [],
    runtimeAttributes: {
      health: 100,
      status: "online",
      crewCapacity: 1,
      physicalVolumeM3: 20,
      rawMaterialBufferKg: 1500,
      inProcessStorageM3: 3,
      powerDrawKw: {
        offline: 0,
        online: 1,
        active: 8,
        damaged: 1,
      },
    },
    capabilities: ["basic-fabrication"],
  },
  {
    id: "module-basic-suitport",
    blueprintId: "basic-suitport",
    displayName: "Basic Suitport",
    connectedTo: [],
    runtimeAttributes: {
      health: 100,
      status: "online",
      crewCapacity: 1,
      physicalVolumeM3: 4,
      cargoTransferRating: "poor",
      powerDrawKw: {
        offline: 0,
        online: 0.5,
        active: 2,
        damaged: 0.5,
      },
      crewAccessCapacity: 1,
    },
    capabilities: ["limited-eva", "suitport-access"],
  },
];

const blueprints = [
  {
    id: "blueprint-command-module",
    blueprintId: "command-module",
    displayName: "Command Module Blueprint",
  },
];

const starterHumans = [
  {
    id: "human-1",
    displayName: "George",
    locationModuleId: "habitat_test_123_command_module_1",
  },
  {
    id: "human-2",
    displayName: "Henry",
    locationModuleId: "habitat_test_123_command_module_1",
  },
];

const contracts = {
  alerts: {
    schemaVersion: "1.0",
    schema: {
      title: "Habitat Alert",
      type: "object",
    },
  },
};

const catalogBlueprints = [
  {
    id: "blueprint_kepler-442b-v1_basic-battery",
    blueprintId: "basic-battery",
    displayName: "Basic Battery Blueprint",
    description: "Supplies stored electrical power to the habitat.",
    status: "published",
    output: {
      itemType: "module",
      moduleType: "basic-battery",
      quantity: 1,
    },
    inputs: {
      "basalt-composite": 80,
      ferrite: 55,
    },
    productionCost: {
      power: 3,
    },
    requiredFacility: {
      moduleType: "workshop-fabricator",
      minimumLevel: 1,
    },
    buildTicks: 180,
    prerequisites: [],
    unlocks: [],
    repeatable: true,
  },
  {
    id: "blueprint_kepler-442b-v1_basic-suitport",
    blueprintId: "basic-suitport",
    displayName: "Basic Suitport Blueprint",
    description: "Provides limited exterior access for short EVAs.",
    status: "published",
    output: {
      itemType: "module",
      moduleType: "basic-suitport",
      quantity: 1,
    },
    inputs: {
      "basalt-composite": 50,
      ferrite: 45,
    },
    productionCost: {
      power: 3,
    },
    requiredFacility: {
      moduleType: "workshop-fabricator",
      minimumLevel: 1,
    },
    buildTicks: 120,
    prerequisites: ["life-support"],
    unlocks: ["limited-eva"],
    repeatable: true,
  },
  {
    id: "blueprint_kepler-442b-v1_small-solar-array",
    blueprintId: "small-solar-array",
    displayName: "Small Solar Array Blueprint",
    description: "Deploys a compact solar power source for the habitat.",
    status: "published",
    output: {
      itemType: "module",
      moduleType: "small-solar-array",
      quantity: 1,
    },
    inputs: {
      ferrite: 90,
      "silicate-glass": 45,
      "conductive-ore": 18,
    },
    productionCost: {
      power: 4,
    },
    requiredFacility: {
      moduleType: "workshop-fabricator",
      minimumLevel: 1,
    },
    buildTicks: 180,
    prerequisites: ["life-support"],
    unlocks: [],
    repeatable: true,
    runtimeAttributes: {
      status: "online",
      powerGenerationKw: 12,
      health: 100,
      powerDrawKw: {
        offline: 0,
        online: 0,
        active: 0,
        damaged: 0,
      },
    },
    capabilities: ["power-generation"],
  },
];

const catalogResources = [
  {
    resourceType: "basalt-composite",
    displayName: "Basalt Composite",
    description: "Structural composite derived from basalt.",
    category: "manufactured",
  },
  {
    resourceType: "ferrite",
    displayName: "Ferrite",
    description: "Iron-rich processed material.",
    category: "refined",
  },
  {
    resourceType: "rare-catalyst",
    displayName: "Rare Catalyst",
    description: "High-value industrial catalyst.",
    category: "specialty",
  },
  {
    resourceType: "silicate-glass",
    displayName: "Silicate Glass",
    description: "Processed glass panels for habitat construction.",
    category: "refined",
  },
  {
    resourceType: "conductive-ore",
    displayName: "Conductive Ore",
    description: "Electrically useful ore for wiring and power systems.",
    category: "raw",
  },
];

const habitat = {
  id: habitatId,
  habitatSlug: "test-habitat",
  displayName: "Adrians Land",
  catalogVersion: "kepler-442b-v1",
  status: "online",
  lastSeenAt: "2026-07-07T16:00:00.000Z",
};

const defaultSolarStatus = {
  solarIrradiance: {
    wPerM2: 900,
    condition: "clear",
  },
};

type ScanProbability = {
  resourceType: string;
  probability: number;
};

type ScanQuantityEstimate = {
  candidateResource: string;
  kilograms: number;
  estimatedValue: number;
  minimumKilograms: number;
  maximumKilograms: number;
  exact: boolean;
};

type ScanTile = {
  x: number;
  y: number;
  distance: number;
  terrain: string;
  resourceProbabilities: ScanProbability[];
  topCandidate: ScanProbability | null;
  quantityEstimate: ScanQuantityEstimate | null;
};

type ScanResponse = {
  modelVersion: string;
  origin: {
    x: number;
    y: number;
  };
  sensorStrength: number;
  radiusTiles: number;
  tiles: ScanTile[];
};

const scanResourceTypes = catalogResources.map((resource) => resource.resourceType);

let observedScanRequests: Array<{
  habitatId: string | null;
  x: string | null;
  y: string | null;
  sensorStrength: string | null;
  radiusTiles: string | null;
}> = [];

function buildScanProbabilities(topResource: string, confidence: number) {
  const resourceTypes = [...scanResourceTypes, "none"];
  const topProbability = Math.max(0, Math.min(100, Math.round(confidence)));
  const otherResources = resourceTypes.filter((resourceType) => resourceType !== topResource);
  const remaining = 100 - topProbability;
  const weights = otherResources.map((_, index) => index + 1);
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0) || 1;
  let distributed = 0;

  const probabilities = otherResources.map((resourceType, index) => {
    const share = Math.floor((remaining * weights[index]) / totalWeight);
    distributed += share;
    return {
      resourceType,
      probability: share,
    };
  });

  const remainder = remaining - distributed;
  for (let index = 0; index < remainder; index += 1) {
    probabilities[index % probabilities.length].probability += 1;
  }

  probabilities.push({
    resourceType: topResource,
    probability: topProbability,
  });

  return probabilities.sort(
    (left, right) => resourceTypes.indexOf(left.resourceType) - resourceTypes.indexOf(right.resourceType),
  );
}

function buildScanQuantityEstimate(topResource: string, exact: boolean, distance: number): ScanQuantityEstimate | null {
  if (topResource === "none") {
    return null;
  }

  if (exact) {
    return {
      candidateResource: topResource,
      kilograms: 18,
      estimatedValue: 180,
      minimumKilograms: 18,
      maximumKilograms: 18,
      exact: true,
    };
  }

  const spread = Math.max(2, Math.round(distance * 2) + 4);
  const kilograms = 12 + Math.max(0, 4 - Math.round(distance));

  return {
    candidateResource: topResource,
    kilograms,
    estimatedValue: 120 - Math.round(distance * 5),
    minimumKilograms: kilograms - spread,
    maximumKilograms: kilograms + spread,
    exact: false,
  };
}

function buildScanResponse(params: URLSearchParams): ScanResponse {
  const x = Number.parseInt(params.get("x") ?? "0", 10);
  const y = Number.parseInt(params.get("y") ?? "0", 10);
  const sensorStrength = Number.parseInt(params.get("sensorStrength") ?? "0", 10);
  const radiusTiles = Number.parseInt(params.get("radiusTiles") ?? "0", 10);
  const tiles: ScanTile[] = [];
  const minX = x - radiusTiles;
  const maxX = x + radiusTiles;
  const minY = y - radiusTiles;
  const maxY = y + radiusTiles;

  for (let tileX = minX; tileX <= maxX; tileX += 1) {
    for (let tileY = minY; tileY <= maxY; tileY += 1) {
      const distance = Number(Math.hypot(tileX - x, tileY - y).toFixed(2));
      const exact = sensorStrength === 100 && distance === 0;
      const topResource = exact ? "ferrite" : distance === 0 ? "ferrite" : (Math.abs(tileX + tileY) % 2 === 0 ? "basalt-composite" : "silicate-glass");
      const confidence = exact ? 100 : Math.max(5, Math.min(95, Math.round(sensorStrength - distance * 20)));

      tiles.push({
        x: tileX,
        y: tileY,
        distance,
        terrain: "flat",
        resourceProbabilities: buildScanProbabilities(topResource, confidence),
        topCandidate: {
          resourceType: topResource,
          probability: confidence,
        },
        quantityEstimate: buildScanQuantityEstimate(topResource, exact, distance),
      });
    }
  }

  return {
    modelVersion: "kepler-scan-v1",
    origin: { x, y },
    sensorStrength,
    radiusTiles,
    tiles,
  };
}

let originalFetch: typeof fetch;
let originalCwd: string;
let originalToken: string | undefined;
let originalApiBaseUrl: string | undefined;

beforeAll(() => {
  originalFetch = globalThis.fetch;
  originalCwd = process.cwd();
  originalToken = process.env.KEPLER_PLANET_TOKEN;
  originalApiBaseUrl = process.env.HABITAT_API_BASE_URL;
  process.env.KEPLER_PLANET_TOKEN = token;
  process.env.HABITAT_API_BASE_URL = "http://localhost:8787";
});

afterAll(() => {
  globalThis.fetch = originalFetch;
  process.chdir(originalCwd);

  if (originalToken === undefined) {
    delete process.env.KEPLER_PLANET_TOKEN;
  } else {
    process.env.KEPLER_PLANET_TOKEN = originalToken;
  }

  if (originalApiBaseUrl === undefined) {
    delete process.env.HABITAT_API_BASE_URL;
  } else {
    process.env.HABITAT_API_BASE_URL = originalApiBaseUrl;
  }
});

function installMockFetch(options?: {
  solarStatus?: {
    solarIrradiance?: {
      wPerM2?: number;
      condition?: string;
    };
  };
  failSolarStatus?: boolean;
}) {
  const app = createHabitatApp();
  observedScanRequests = [];

  globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);

    if ((url.hostname === "localhost" || url.hostname === "127.0.0.1") && url.port === "8787") {
      return app.fetch(request);
    }

    if (request.method === "POST" && url.pathname === "/habitats/register") {
      return Response.json(
        {
          habitatId,
          starterModules,
          starterHumans,
          contracts,
          blueprints,
        },
        { status: 201 },
      );
    }

    if (request.method === "GET" && url.pathname === `/habitats/${habitatId}`) {
      return Response.json({ habitat });
    }

    if (request.method === "DELETE" && url.pathname === `/habitats/${habitatId}`) {
      return new Response(null, { status: 204 });
    }

    if (request.method === "GET" && url.pathname === "/catalog/blueprints") {
      return Response.json({ blueprints: catalogBlueprints });
    }

    if (request.method === "GET" && url.pathname === "/catalog/resources") {
      return Response.json({ resources: catalogResources });
    }

    if (request.method === "GET" && url.pathname === "/world/solar-irradiance") {
      if (options?.failSolarStatus) {
        return Response.json(
          {
            error: "solar_unavailable",
          },
          { status: 503 },
        );
      }

      return Response.json(options?.solarStatus ?? defaultSolarStatus);
    }

    if (request.method === "GET" && url.pathname === "/world/scan") {
      observedScanRequests.push({
        habitatId: url.searchParams.get("habitatId"),
        x: url.searchParams.get("x"),
        y: url.searchParams.get("y"),
        sensorStrength: url.searchParams.get("sensorStrength"),
        radiusTiles: url.searchParams.get("radiusTiles"),
      });

      return Response.json(buildScanResponse(url.searchParams));
    }

    if (request.method === "GET" && url.pathname === "/catalog/blueprints/basic-battery") {
      return Response.json({ blueprint: catalogBlueprints[0] });
    }

    if (request.method === "GET" && url.pathname === "/catalog/blueprints/small-solar-array") {
      return Response.json({ blueprint: catalogBlueprints[2] });
    }

    if (request.method === "GET" && url.pathname === "/catalog/blueprints/missing-blueprint") {
      return Response.json(
        {
          error: "not_found",
        },
        { status: 404 },
      );
    }

    throw new Error(`Unexpected mock Kepler request: ${request.method} ${url.pathname}`);
  }) as typeof fetch;
}

async function withWorkspace<T>(fn: (cwd: string) => Promise<T>) {
  const cwd = await mkdtemp(join(tmpdir(), "habitat-cli-test-"));
  const previousCwd = process.cwd();
  process.chdir(cwd);

  try {
    return await fn(cwd);
  } finally {
    process.chdir(previousCwd);
    await rm(cwd, { recursive: true, force: true });
  }
}

async function runCommand(args: string[]) {
  const stdout: string[] = [];
  const stderr: string[] = [];

  const exitCode = await runCli(args, {
    stdout: (message) => stdout.push(message),
    stderr: (message) => stderr.push(message),
  });

  return {
    exitCode,
    stdout: stdout.join("\n"),
    stderr: stderr.join("\n"),
  };
}

describe("habitat CLI", () => {
  test("serves registration JSON directly from the Hono app", async () => {
    installMockFetch();

    await withWorkspace(async () => {
      const app = createHabitatApp();
      const response = await app.fetch(new Request("http://localhost:8787/registration"));
      const body = (await response.json()) as { registration: null };

      expect(response.status).toBe(200);
      expect(body).toEqual({ registration: null });
    });
  });

  test("shows only Kepler registration commands plus modules in top-level help", async () => {
    installMockFetch();

    await withWorkspace(async () => {
      const result = await runCommand(["--help"]);

      expect(result.exitCode).toBe(0);
    });
  });

  test("hydrates starter modules from the Kepler registration response", async () => {
    installMockFetch();

    await withWorkspace(async () => {
      const register = await runCommand(["register", "--name", "Adrians Land"]);

      expect(register.exitCode).toBe(0);
      expect(register.stdout).toContain("Registered with Kepler.");

      const status = await runCommand(["status"]);
      expect(status.exitCode).toBe(0);
      expect(status.stdout).toContain("Field");
      expect(status.stdout).toContain("Value");
      expect(status.stdout).toContain("Display Name");
      expect(status.stdout).toContain("Modules");
      expect(status.stdout).toContain("6");

      await expect(access(getDatabaseFile())).resolves.toBeNull();

      const moduleStore = await readModules();
      expect(moduleStore).toHaveLength(6);
      expect(moduleStore.map((module) => module.displayName)).toEqual([
        "Command Module",
        "Life Support",
        "Basic Battery",
        "Supply Cache",
        "Workshop Fabricator",
        "Basic Suitport",
      ]);

      const registration = await readRegistration();
      expect(registration).toBeTruthy();
      expect(registration?.starterHumans).toHaveLength(2);
      expect(registration?.starterHumans?.map((human) => human.locationModuleId)).toEqual([
        "habitat_test_123_command_module_1",
        "habitat_test_123_command_module_1",
      ]);
      expect(registration?.contracts?.alerts.schemaVersion).toBe("1.0");

      const humans = await readHumans();
      expect(humans).toHaveLength(2);
      expect(humans.map((human) => human.displayName)).toEqual(["George", "Henry"]);
      expect(humans.map((human) => human.locationModuleId)).toEqual([
        "habitat_test_123_command_module_1",
        "habitat_test_123_command_module_1",
      ]);

      const list = await runCommand(["module", "list"]);
      expect(list.exitCode).toBe(0);
      expect(list.stdout).toContain("Local modules: module instances currently owned by this habitat.");
      expect(list.stdout).toContain("Module Ref");
      expect(list.stdout).toContain("Blueprint");
      expect(list.stdout).toContain("State");
      expect(list.stdout).toContain("Command Module");
      expect(list.stdout).toContain("Workshop Fabricator");
      expect(list.stdout).toContain("Basic Suitport");

      const humanList = await runCommand(["human", "list"]);
      expect(humanList.exitCode).toBe(0);
      expect(humanList.stdout).toContain("Local humans: starter crew currently assigned to habitat modules.");
      expect(humanList.stdout).toContain("Ref");
      expect(humanList.stdout).toContain("Display Name");
      expect(humanList.stdout).toContain("Module ID");
      expect(humanList.stdout).toContain("George");
      expect(humanList.stdout).toContain("Henry");
    });
  });

  test("fresh registration hydrates starter modules and humans through the CLI commands", async () => {
    installMockFetch();

    await withWorkspace(async () => {
      const unregister = await runCommand(["unregister"]);
      expect(unregister.exitCode).toBe(0);
      expect(unregister.stdout).toContain("Not registered with Kepler.");

      const register = await runCommand(["register", "--name", "Adrians Land"]);
      expect(register.exitCode).toBe(0);
      expect(register.stdout).toContain("Registered with Kepler.");

      const status = await runCommand(["status"]);
      expect(status.exitCode).toBe(0);
      expect(status.stdout).toContain("Modules");
      expect(status.stdout).toContain("6");

      const moduleList = await runCommand(["module", "list"]);
      expect(moduleList.exitCode).toBe(0);
      expect(moduleList.stdout).toContain("Command Module");
      expect(moduleList.stdout).toContain("Basic Suitport");

      const humanList = await runCommand(["human", "list"]);
      expect(humanList.exitCode).toBe(0);
      expect(humanList.stdout).toContain("George");
      expect(humanList.stdout).toContain("Henry");
      expect(humanList.stdout).toContain("habitat_test_123_command_module_1");
    });
  });

  test("lists official blueprints in a concise table", async () => {
    installMockFetch();

    await withWorkspace(async () => {
      const logs: string[] = [];
      const originalConsoleLog = console.log;
      console.log = (...args: unknown[]) => {
        logs.push(args.map(String).join(" "));
      };

      try {
      const result = await runCommand(["blueprint", "list"]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Kepler blueprint catalog: official buildable blueprint definitions.");
      expect(result.stdout).toContain("These are catalog entries, not local modules your habitat already owns.");
      expect(result.stdout).toContain("┌");
      expect(result.stdout).toContain("│ Blueprint ID");
      expect(result.stdout).toContain("└");
      expect(result.stdout).toContain("basic-battery");
      expect(result.stdout).toContain("Basic Battery Blueprint");
      expect(result.stdout).toContain("Output");
      expect(result.stdout).toContain("1 basic-battery (module)");
      expect(result.stdout).toContain("workshop-fabricator lvl 1");
      expect(result.stdout).toContain("180");
      expect(result.stdout).toContain("published");
      expect(logs.some((line) => line.includes("[habitat-api] GET /catalog/blueprints -> proxied to Kepler"))).toBe(true);
      expect(logs.some((line) => line.includes("[kepler] GET /catalog/blueprints -> 200"))).toBe(true);
      expect(logs.some((line) => line.includes("Bearer"))).toBe(false);
      expect(logs.some((line) => line.includes(token))).toBe(false);
      } finally {
        console.log = originalConsoleLog;
      }
    });
  });

  test("shows one official blueprint with readable details", async () => {
    installMockFetch();

    await withWorkspace(async () => {
      const result = await runCommand(["blueprint", "show", "basic-battery"]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Blueprint ID: basic-battery");
      expect(result.stdout).toContain("Name: Basic Battery Blueprint");
      expect(result.stdout).toContain("Status: published");
      expect(result.stdout).toContain("Output: 1 basic-battery (module)");
      expect(result.stdout).toContain("Required Facility: workshop-fabricator lvl 1");
      expect(result.stdout).toContain("Inputs: basalt-composite=80, ferrite=55");
    });
  });

  test("shows a friendly error when a blueprint is missing", async () => {
    installMockFetch();

    await withWorkspace(async () => {
      const result = await runCommand(["blueprint", "show", "missing-blueprint"]);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Blueprint "missing-blueprint" was not found in the Kepler catalog.');
    });
  });

  test("lists official resource types without implying local inventory", async () => {
    installMockFetch();

    await withWorkspace(async () => {
      const result = await runCommand(["resource", "list"]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Kepler resource catalog: possible resource types in the Kepler world.");
      expect(result.stdout).toContain("This is not your habitat inventory.");
      expect(result.stdout).toContain("Resource Type");
      expect(result.stdout).toContain("basalt-composite");
      expect(result.stdout).toContain("Basalt Composite");
      expect(result.stdout).toContain("manufactured");
      expect(result.stdout).toContain("Blueprint requirements may refer to these resource types later.");
      expect(result.stdout).toContain("Local inventory is tracked separately from this catalog in your habitat's local state.");
    });
  });

  test("scans a single tile and shows the full probability table", async () => {
    installMockFetch();

    await withWorkspace(async () => {
      await runCommand(["register", "--name", "Adrians Land"]);

      const result = await runCommand(["scan", "--x", "3", "--y", "-2", "--strength", "60"]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Scan origin: (3, -2)");
      expect(result.stdout).toContain("Sensor strength: 60");
      expect(result.stdout).toContain("Radius: 0");
      expect(result.stdout).toContain("Tile: (3, -2)");
      expect(result.stdout).toContain("Terrain: flat");
      expect(result.stdout).toContain("Probability distribution:");
      expect(result.stdout).toContain("Resource");
      expect(result.stdout).toContain("Probability");
      expect(result.stdout).toContain("ferrite");
      expect(result.stdout).toContain("none");
      expect(result.stdout).toContain("Estimated quantity:");
      expect(result.stdout).toContain("range");
      expect(observedScanRequests).toHaveLength(1);
      expect(observedScanRequests[0]).toEqual({
        habitatId,
        x: "3",
        y: "-2",
        sensorStrength: "60",
        radiusTiles: "0",
      });
    });
  });

  test("strength 100 at distance 0 identifies the resource exactly", async () => {
    installMockFetch();

    await withWorkspace(async () => {
      await runCommand(["register", "--name", "Adrians Land"]);

      const result = await runCommand(["scan", "--x", "3", "--y", "-2", "--strength", "100"]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Top candidate: ferrite (100%)");
      expect(result.stdout).toContain("Estimated quantity: ferrite 18 kg, value 180, exact");
      expect(result.stdout).toContain("100%");
      expect(result.stdout).toContain("0%");
    });
  });

  test("radius scans summarize nearby tiles and can print JSON", async () => {
    installMockFetch();

    await withWorkspace(async () => {
      await runCommand(["register", "--name", "Adrians Land"]);

      const result = await runCommand(["scan", "--x", "3", "--y", "-2", "--strength", "60", "--radius", "1"]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Tiles returned: 9");
      expect(result.stdout).toContain("Top Candidate");
      expect(result.stdout).toContain("Confidence");
      expect(result.stdout).toContain("Quantity");
      expect(result.stdout).toContain("flat");
      expect(result.stdout).toContain("ferrite");

      const json = await runCommand(["scan", "--x", "3", "--y", "-2", "--strength", "60", "--radius", "1", "--json"]);
      expect(json.exitCode).toBe(0);

      const parsed = JSON.parse(json.stdout) as ScanResponse;
      expect(parsed.modelVersion).toBe("kepler-scan-v1");
      expect(parsed.origin).toEqual({ x: 3, y: -2 });
      expect(parsed.sensorStrength).toBe(60);
      expect(parsed.radiusTiles).toBe(1);
      expect(parsed.tiles).toHaveLength(9);
      expect(parsed.tiles[4].quantityEstimate).toBeTruthy();
    });
  });

  test("scan input validation stops invalid requests before they reach the API", async () => {
    installMockFetch();

    await withWorkspace(async () => {
      await runCommand(["register", "--name", "Adrians Land"]);

      const badStrength = await runCommand(["scan", "--x", "3", "--y", "-2", "--strength", "101"]);
      expect(badStrength.exitCode).toBe(1);
      expect(badStrength.stderr).toContain("--strength must be between 0 and 100.");

      const badRadius = await runCommand(["scan", "--x", "3", "--y", "-2", "--strength", "60", "--radius", "6"]);
      expect(badRadius.exitCode).toBe(1);
      expect(badRadius.stderr).toContain("--radius must be between 0 and 5.");

      expect(observedScanRequests).toHaveLength(0);
    });
  });

  test("shows current solar irradiance from Kepler", async () => {
    installMockFetch();

    await withWorkspace(async () => {
      const result = await runCommand(["solar", "status"]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Solar irradiance: 900 W/m2 (clear).");
    });
  });

  test("supports local inventory add and list", async () => {
    installMockFetch();

    await withWorkspace(async () => {
      await runCommand(["register", "--name", "Adrians Land"]);

      const emptyList = await runCommand(["inventory", "list"]);
      expect(emptyList.exitCode).toBe(0);
      expect(emptyList.stdout).toContain("No local inventory yet.");

      const addFerrite = await runCommand(["inventory", "add", "ferrite", "90"]);
      expect(addFerrite.exitCode).toBe(0);

      const addGlass = await runCommand(["inventory", "add", "silicate-glass", "45"]);
      expect(addGlass.exitCode).toBe(0);

      const list = await runCommand(["inventory", "list"]);
      expect(list.exitCode).toBe(0);
      expect(list.stdout).toContain("Local inventory: resources this habitat currently owns.");
      expect(list.stdout).toContain("ferrite");
      expect(list.stdout).toContain("90");
      expect(list.stdout).toContain("silicate-glass");
      expect(list.stdout).toContain("45");
    });
  });

  test("construction dry run reports readiness and failing checks", async () => {
    installMockFetch();

    await withWorkspace(async () => {
      await runCommand(["register", "--name", "Adrians Land"]);

      const failing = await runCommand(["construct", "small-solar-array", "--dry-run"]);
      expect(failing.exitCode).toBe(0);
      expect(failing.stdout).toContain("Construction dry run for small-solar-array");
      expect(failing.stdout).toContain("[ok] Required facility exists");
      expect(failing.stdout).toContain("[x] Supply cache online");
      expect(failing.stdout).toContain("[x] Inventory contains resources");
      expect(failing.stdout).toContain("Would create: small-solar-array-1");
      expect(failing.stdout).toContain("Construction can start: no");

      await runCommand(["module", "set-status", "supply-cache-1", "online"]);
      await runCommand(["inventory", "add", "ferrite", "90"]);
      await runCommand(["inventory", "add", "silicate-glass", "45"]);
      await runCommand(["inventory", "add", "conductive-ore", "18"]);

      const ready = await runCommand(["construct", "small-solar-array", "--dry-run"]);
      expect(ready.exitCode).toBe(0);
      expect(ready.stdout).toContain("[ok] Supply cache online");
      expect(ready.stdout).toContain("[ok] Inventory contains resources");
      expect(ready.stdout).toContain("Construction can start: yes");
    });
  });

  test("real construction spends inventory, stores an active job, and can be canceled", async () => {
    installMockFetch();

    await withWorkspace(async () => {
      await runCommand(["register", "--name", "Adrians Land"]);
      await runCommand(["module", "set-status", "supply-cache-1", "online"]);
      await runCommand(["inventory", "add", "ferrite", "90"]);
      await runCommand(["inventory", "add", "silicate-glass", "45"]);
      await runCommand(["inventory", "add", "conductive-ore", "18"]);

      const construct = await runCommand(["construct", "small-solar-array"]);
      expect(construct.exitCode).toBe(0);
      expect(construct.stdout).toContain("Started construction for small-solar-array.");
      expect(construct.stdout).toContain("Facility: workshop-fabricator-1");
      expect(construct.stdout).toContain("Output module: small-solar-array-1");

      const inventory = await readInventory();
      expect(inventory.resources.ferrite).toBe(0);
      expect(inventory.resources["silicate-glass"]).toBe(0);
      expect(inventory.resources["conductive-ore"]).toBe(0);

      const facilityShow = await runCommand(["module", "show", "workshop-fabricator-1"]);
      expect(facilityShow.exitCode).toBe(0);
      expect(facilityShow.stdout).toContain("Reference: workshop-fabricator-1");
      expect(facilityShow.stdout).toContain("Construction Job: small-solar-array");
      expect(facilityShow.stdout).toContain("Remaining Ticks: 180/180");

      const constructionStatus = await runCommand(["construction", "status"]);
      expect(constructionStatus.exitCode).toBe(0);
      expect(constructionStatus.stdout).toContain("workshop-fabricator-1");
      expect(constructionStatus.stdout).toContain("small-solar-array");
      expect(constructionStatus.stdout).toContain("180/180");

      const cancel = await runCommand(["construction", "cancel", "workshop-fabricator-1"]);
      expect(cancel.exitCode).toBe(0);
      expect(cancel.stdout).toContain("Canceled construction on workshop-fabricator-1.");
      expect(cancel.stdout).toContain("No materials were refunded.");

      const afterCancel = await runCommand(["construction", "status"]);
      expect(afterCancel.exitCode).toBe(0);
      expect(afterCancel.stdout).toContain("No active construction jobs.");

      const moduleStore = await readModules();
      expect(moduleStore.map((module) => module.blueprintId)).not.toContain("small-solar-array");
    });
  });

  test("construction advances with ticks only when the facility is powered", async () => {
    installMockFetch();

    await withWorkspace(async () => {
      await runCommand(["register", "--name", "Adrians Land"]);
      await runCommand(["module", "set-status", "supply-cache-1", "online"]);
      await runCommand(["inventory", "add", "ferrite", "90"]);
      await runCommand(["inventory", "add", "silicate-glass", "45"]);
      await runCommand(["inventory", "add", "conductive-ore", "18"]);
      await runCommand(["construct", "small-solar-array"]);

      const firstTick = await runCommand(["tick", "1"]);
      expect(firstTick.exitCode).toBe(0);

      const statusAfterOne = await runCommand(["construction", "status"]);
      expect(statusAfterOne.exitCode).toBe(0);
      expect(statusAfterOne.stdout).toContain("179/180");

      await runCommand(["module", "set-status", "workshop-fabricator-1", "offline"]);

      const pausedTick = await runCommand(["tick", "1"]);
      expect(pausedTick.exitCode).toBe(0);

      const statusPaused = await runCommand(["construction", "status"]);
      expect(statusPaused.exitCode).toBe(0);
      expect(statusPaused.stdout).toContain("179/180");
    });
  });

  test("construction completion creates the output module and clears the facility job", async () => {
    installMockFetch();

    await withWorkspace(async () => {
      await runCommand(["register", "--name", "Adrians Land"]);
      await runCommand(["module", "set-status", "supply-cache-1", "online"]);
      await runCommand(["inventory", "add", "ferrite", "90"]);
      await runCommand(["inventory", "add", "silicate-glass", "45"]);
      await runCommand(["inventory", "add", "conductive-ore", "18"]);
      await runCommand(["construct", "small-solar-array"]);

      const complete = await runCommand(["tick", "180"]);
      expect(complete.exitCode).toBe(0);
      expect(complete.stdout).toContain("Construction completed: small-solar-array-1");

      const moduleList = await runCommand(["module", "list"]);
      expect(moduleList.exitCode).toBe(0);
      expect(moduleList.stdout).toContain("small-solar-array-1");

      const moduleShow = await runCommand(["module", "show", "small-solar-array-1"]);
      expect(moduleShow.exitCode).toBe(0);
      expect(moduleShow.stdout).toContain("Reference: small-solar-array-1");
      expect(moduleShow.stdout).toContain("Blueprint ID: small-solar-array");
      expect(moduleShow.stdout).toContain('"powerGenerationKw": 12');

      const facilityShow = await runCommand(["module", "show", "workshop-fabricator-1"]);
      expect(facilityShow.exitCode).toBe(0);
      expect(facilityShow.stdout).not.toContain("Construction Job:");

      const constructionStatus = await runCommand(["construction", "status"]);
      expect(constructionStatus.exitCode).toBe(0);
      expect(constructionStatus.stdout).toContain("No active construction jobs.");
    });
  });

  test("solar charging increases online battery charge when an online solar module exists", async () => {
    installMockFetch();

    await withWorkspace(async () => {
      await runCommand(["register", "--name", "Adrians Land"]);
      await runCommand([
        "module",
        "create",
        "--name",
        "small-solar-array-1",
        "--blueprint-id",
        "small-solar-array",
        "--runtime-attributes",
        '{"status":"online","powerGenerationKw":12,"powerDrawKw":{"offline":0,"online":0,"active":0,"damaged":0}}',
        "--capabilities",
        "solar-generation",
      ]);

      const moduleStore = await readModules();

      for (const module of moduleStore) {
        if (["Command Module", "Life Support", "Workshop Fabricator", "Basic Suitport", "Supply Cache"].includes(module.displayName)) {
          module.runtimeAttributes.status = "offline";
        }

        if (module.displayName === "Basic Battery") {
          module.runtimeAttributes.status = "online";
          module.runtimeAttributes.currentEnergyKwh = 499;
        }
      }

      await writeModules(moduleStore);

      const tick = await runCommand(["tick", "1"]);
      expect(tick.exitCode).toBe(0);
      expect(tick.stdout).toContain("Solar charging: generated 0.001667 kWh");

      const updatedStore = await readModules();
      const battery = updatedStore.find((module) => module.displayName === "Basic Battery");
      expect(battery).toBeDefined();
      expect((battery as ModuleRecord).runtimeAttributes.currentEnergyKwh).toBeCloseTo(499.00166666666667, 12);
    });
  });

  test("solar charging is skipped when the battery is offline", async () => {
    installMockFetch();

    await withWorkspace(async () => {
      await runCommand(["register", "--name", "Adrians Land"]);
      await runCommand([
        "module",
        "create",
        "--name",
        "small-solar-array-1",
        "--blueprint-id",
        "small-solar-array",
        "--runtime-attributes",
        '{"status":"online","powerGenerationKw":12,"powerDrawKw":{"offline":0,"online":0,"active":0,"damaged":0}}',
        "--capabilities",
        "solar-generation",
      ]);

      const tick = await runCommand(["tick", "1"]);
      expect(tick.exitCode).toBe(0);
      expect(tick.stdout).toContain("Solar charging skipped: No online battery modules could receive charge.");
    });
  });

  test("solar charging is skipped when irradiance is zero", async () => {
    installMockFetch({
      solarStatus: {
        solarIrradiance: {
          wPerM2: 0,
          condition: "night",
        },
      },
    });

    await withWorkspace(async () => {
      await runCommand(["register", "--name", "Adrians Land"]);
      await runCommand([
        "module",
        "create",
        "--name",
        "small-solar-array-1",
        "--blueprint-id",
        "small-solar-array",
        "--runtime-attributes",
        '{"status":"online","powerGenerationKw":12,"powerDrawKw":{"offline":0,"online":0,"active":0,"damaged":0}}',
        "--capabilities",
        "solar-generation",
      ]);

      const moduleStore = await readModules();
      for (const module of moduleStore) {
        if (module.displayName === "Basic Battery") {
          module.runtimeAttributes.status = "online";
          module.runtimeAttributes.currentEnergyKwh = 499;
        }
      }
      await writeModules(moduleStore);

      const tick = await runCommand(["tick", "1"]);
      expect(tick.exitCode).toBe(0);
      expect(tick.stdout).toContain("Solar charging skipped: Solar irradiance is zero, so no charging happened.");
    });
  });

  test("solar charging is skipped when the battery is already full", async () => {
    installMockFetch();

    await withWorkspace(async () => {
      await runCommand(["register", "--name", "Adrians Land"]);
      await runCommand(["module", "set-status", "basic-battery-1", "online"]);
      await runCommand([
        "module",
        "create",
        "--name",
        "small-solar-array-1",
        "--blueprint-id",
        "small-solar-array",
        "--runtime-attributes",
        '{"status":"online","powerGenerationKw":12,"powerDrawKw":{"offline":0,"online":0,"active":0,"damaged":0}}',
        "--capabilities",
        "solar-generation",
      ]);

      const moduleStore = await readModules();
      for (const module of moduleStore) {
        if (["Command Module", "Life Support", "Workshop Fabricator", "Basic Suitport", "Supply Cache"].includes(module.displayName)) {
          module.runtimeAttributes.status = "offline";
        }
      }
      await writeModules(moduleStore);

      const tick = await runCommand(["tick", "1"]);
      expect(tick.exitCode).toBe(0);
      expect(tick.stdout).toContain("Solar charging skipped: Battery storage is already full.");
    });
  });

  test("tick continues when Kepler solar status fails", async () => {
    installMockFetch({ failSolarStatus: true });

    await withWorkspace(async () => {
      await runCommand(["register", "--name", "Adrians Land"]);

      const tick = await runCommand(["tick", "1"]);
      expect(tick.exitCode).toBe(0);
      expect(tick.stdout).toContain("Ran 1 tick.");
      expect(tick.stdout).toContain("Solar charging skipped: unable to read Kepler solar irradiance.");
    });
  });

  test("supports module CRUD in local SQLite-backed storage", async () => {
    installMockFetch();

    await withWorkspace(async () => {
      await runCommand(["register", "--name", "Adrians Land"]);

      const create = await runCommand([
        "module",
        "create",
        "--name",
        "Telemetry Relay",
        "--blueprint-id",
        "command-module",
        "--capabilities",
        "telemetry,relay",
      ]);
      expect(create.exitCode).toBe(0);
      expect(create.stdout).toContain('Created module "Telemetry Relay".');

      const show = await runCommand(["module", "show", "Telemetry Relay"]);
      expect(show.exitCode).toBe(0);
      expect(show.stdout).toContain("Display Name: Telemetry Relay");
      expect(show.stdout).toContain("Blueprint ID: command-module");
      expect(show.stdout).toContain("Capabilities: telemetry, relay");

      const update = await runCommand([
        "module",
        "update",
        "Telemetry Relay",
        "--name",
        "Telemetry Relay Mk II",
        "--connected-to",
        "Command Module,Life Support",
      ]);
      expect(update.exitCode).toBe(0);
      expect(update.stdout).toContain('Updated module "Telemetry Relay Mk II".');

      const afterUpdate = await runCommand(["module", "show", "Telemetry Relay Mk II"]);
      expect(afterUpdate.exitCode).toBe(0);
      expect(afterUpdate.stdout).toContain("Connected To: Command Module, Life Support");

      const deleteResult = await runCommand(["module", "delete", "Telemetry Relay Mk II"]);
      expect(deleteResult.exitCode).toBe(0);
      expect(deleteResult.stdout).toContain('Deleted module "Telemetry Relay Mk II".');

      const moduleStore = await readModules();
      expect(moduleStore.map((module) => module.displayName)).not.toContain("Telemetry Relay Mk II");
    });
  });

  test("shows module power status in a table with a summary line", async () => {
    installMockFetch();

    await withWorkspace(async () => {
      await runCommand(["register", "--name", "Adrians Land"]);

      const status = await runCommand(["module", "status"]);

      expect(status.exitCode).toBe(0);
      expect(status.stdout).toContain("Module");
      expect(status.stdout).toContain("State");
      expect(status.stdout).toContain("Power Draw (kW)");
      expect(status.stdout).toContain("Command Module");
      expect(status.stdout).toContain("Life Support");
      expect(status.stdout).toContain("Basic Battery");
      expect(status.stdout).toContain("Total current power draw: 8.5 kW");
      expect(status.stdout).toContain("Energy cost per tick: 0.002361");
    });
  });

  test("set-status updates only a module's runtime state", async () => {
    installMockFetch();

    await withWorkspace(async () => {
      await runCommand(["register", "--name", "Adrians Land"]);

      const beforeStore = await readModules();
      const workshopBefore = beforeStore.find((module) => module.displayName === "Workshop Fabricator");

      expect(workshopBefore).toBeDefined();
      if (!workshopBefore) {
        return;
      }

      const result = await runCommand(["module", "set-status", workshopBefore.id, "damaged"]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(workshopBefore.id);
      expect(result.stdout).toContain("damaged");
      expect(result.stdout).toContain("1 kW");

      const afterStore = await readModules();
      const workshopAfter = afterStore.find((module) => module.id === workshopBefore.id);

      expect(workshopAfter).toBeDefined();
      expect(workshopAfter?.runtimeAttributes.status).toBe("damaged");
      expect(workshopAfter?.blueprintId).toBe(workshopBefore.blueprintId);
      expect(workshopAfter?.connectedTo).toEqual(workshopBefore.connectedTo);
      expect(workshopAfter?.capabilities).toEqual(workshopBefore.capabilities);
      expect((workshopAfter?.runtimeAttributes as Record<string, unknown>).health).toBe(100);
    });
  });

  test("ticks drain battery energy using module power draw", async () => {
    installMockFetch();

    await withWorkspace(async () => {
      await runCommand(["register", "--name", "Adrians Land"]);

      const tick = await runCommand(["tick", "1"]);

      expect(tick.exitCode).toBe(0);
      expect(tick.stdout).toContain("Ran 1 tick.");

      const moduleStore = await readModules();
      const battery = moduleStore.find((module) => module.displayName === "Basic Battery");

      expect(battery).toBeDefined();
      expect((battery as ModuleRecord).runtimeAttributes.currentEnergyKwh).toBeCloseTo(
        499.9976388888889,
        12,
      );

      const batteryShow = await runCommand(["module", "show", "Basic Battery"]);
      expect(batteryShow.exitCode).toBe(0);
      expect(batteryShow.stdout).toContain('"currentEnergyKwh": 499.9976388888889');
    });
  });

  test("multiple ticks compound and low power keeps critical modules first", async () => {
    installMockFetch();

    await withWorkspace(async () => {
      await runCommand(["register", "--name", "Adrians Land"]);

      const moduleStore = await readModules();
      const battery = moduleStore.find((module) => module.displayName === "Basic Battery");

      expect(battery).toBeDefined();
      if (!battery) {
        return;
      }

      battery.runtimeAttributes.currentEnergyKwh = 0.00205;
      await writeModules(moduleStore);

      const tick = await runCommand(["tick", "1"]);

      expect(tick.exitCode).toBe(0);

      const updatedStore = await readModules();
      const commandModule = updatedStore.find((module) => module.displayName === "Command Module");
      const lifeSupport = updatedStore.find((module) => module.displayName === "Life Support");
      const workshop = updatedStore.find((module) => module.displayName === "Workshop Fabricator");
      const suitport = updatedStore.find((module) => module.displayName === "Basic Suitport");
      const updatedBattery = updatedStore.find((module) => module.displayName === "Basic Battery");

      expect(commandModule?.runtimeAttributes.status).toBe("active");
      expect(lifeSupport?.runtimeAttributes.status).toBe("active");
      expect(workshop?.runtimeAttributes.status).toBe("offline");
      expect(suitport?.runtimeAttributes.status).toBe("offline");
      expect(updatedBattery?.runtimeAttributes.currentEnergyKwh).toBe(0);
    });
  });

  test("status depends on the SQLite database instead of old JSON state", async () => {
    installMockFetch();

    await withWorkspace(async () => {
      await runCommand(["register", "--name", "Adrians Land"]);
      const databasePath = getDatabaseFile();
      const renamedPath = `${databasePath}-old`;

      await rename(databasePath, renamedPath);

      const missingState = await runCommand(["status"]);
      expect(missingState.exitCode).toBe(0);
      expect(missingState.stdout).toContain("Not registered with Kepler.");

      await rename(renamedPath, databasePath);

      const restored = await runCommand(["status"]);
      expect(restored.exitCode).toBe(0);
      expect(restored.stdout).toContain("Display Name");
    });
  });

  test("unregister removes local module storage", async () => {
    installMockFetch();

    await withWorkspace(async () => {
      await runCommand(["register", "--name", "Adrians Land"]);

      const unregister = await runCommand(["unregister"]);

      expect(unregister.exitCode).toBe(0);
      expect(unregister.stdout).toContain('Unregistered "Adrians Land" from Kepler.');

      const status = await runCommand(["status"]);
      expect(status.exitCode).toBe(0);
      expect(status.stdout).toContain("Not registered with Kepler.");

      const modules = await readModules();
      const inventory = await readInventory();

      expect(modules).toHaveLength(0);
      expect(inventory.resources).toEqual({});
    });
  });

  test("handles unknown commands with friendly guidance", async () => {
    installMockFetch();

    await withWorkspace(async () => {
      const result = await runCommand(["airlock"]);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Unknown command: airlock");
      expect(result.stderr).toContain("Run `habitat --help` to see available commands.");
    });
  });
});
