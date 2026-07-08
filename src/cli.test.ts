import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { runCli } from "./cli";

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
];

const habitat = {
  id: habitatId,
  habitatSlug: "test-habitat",
  displayName: "Adrians Land",
  catalogVersion: "kepler-442b-v1",
  status: "online",
  lastSeenAt: "2026-07-07T16:00:00.000Z",
};

let originalFetch: typeof fetch;
let originalCwd: string;
let originalToken: string | undefined;

beforeAll(() => {
  originalFetch = globalThis.fetch;
  originalCwd = process.cwd();
  originalToken = process.env.KEPLER_PLANET_TOKEN;
  process.env.KEPLER_PLANET_TOKEN = token;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
  process.chdir(originalCwd);

  if (originalToken === undefined) {
    delete process.env.KEPLER_PLANET_TOKEN;
  } else {
    process.env.KEPLER_PLANET_TOKEN = originalToken;
  }
});

function installMockFetch() {
  globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/habitats/register") {
      return Response.json(
        {
          habitatId,
          starterModules,
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

    if (request.method === "GET" && url.pathname === "/catalog/blueprints/basic-battery") {
      return Response.json({ blueprint: catalogBlueprints[0] });
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

async function readJson<T>(path: string) {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function writeJson(path: string, value: unknown) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

describe("habitat CLI", () => {
  test("shows only Kepler registration commands plus modules in top-level help", async () => {
    installMockFetch();

    await withWorkspace(async () => {
      const result = await runCommand(["--help"]);

      expect(result.exitCode).toBe(0);
    });
  });

  test("hydrates starter modules from the Kepler registration response", async () => {
    installMockFetch();

    await withWorkspace(async (cwd) => {
      const register = await runCommand(["register", "--name", "Adrians Land"]);

      expect(register.exitCode).toBe(0);
      expect(register.stdout).toContain("Registered with Kepler.");

      const status = await runCommand(["status"]);
      expect(status.exitCode).toBe(0);
      expect(status.stdout).toContain("Modules: 6");

      const moduleStorePath = join(cwd, ".habitat", "modules.json");
      expect(await readFile(moduleStorePath, "utf8")).toContain("Command Module");

      const moduleStore = await readJson<{ modules: ModuleRecord[] }>(moduleStorePath);
      expect(moduleStore.modules).toHaveLength(6);
      expect(moduleStore.modules.map((module) => module.displayName)).toEqual([
        "Command Module",
        "Life Support",
        "Basic Battery",
        "Supply Cache",
        "Workshop Fabricator",
        "Basic Suitport",
      ]);

      const list = await runCommand(["module", "list"]);
      expect(list.exitCode).toBe(0);
      expect(list.stdout).toContain("Command Module");
      expect(list.stdout).toContain("Workshop Fabricator");
      expect(list.stdout).toContain("Basic Suitport");
    });
  });

  test("lists official blueprints in a concise table", async () => {
    installMockFetch();

    await withWorkspace(async () => {
      const result = await runCommand(["blueprint", "list"]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Blueprint ID");
      expect(result.stdout).toContain("basic-battery");
      expect(result.stdout).toContain("Basic Battery Blueprint");
      expect(result.stdout).toContain("workshop-fabricator lvl 1");
      expect(result.stdout).toContain("180");
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
      expect(result.stdout).toContain("Local inventory will be tracked separately in habitat files later.");
    });
  });

  test("supports module CRUD in local JSON storage", async () => {
    installMockFetch();

    await withWorkspace(async (cwd) => {
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

      const moduleStorePath = join(cwd, ".habitat", "modules.json");
      const moduleStore = await readJson<{ modules: ModuleRecord[] }>(moduleStorePath);
      expect(moduleStore.modules.map((module) => module.displayName)).not.toContain("Telemetry Relay Mk II");
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

    await withWorkspace(async (cwd) => {
      await runCommand(["register", "--name", "Adrians Land"]);

      const moduleStorePath = join(cwd, ".habitat", "modules.json");
      const beforeStore = await readJson<{ modules: ModuleRecord[] }>(moduleStorePath);
      const workshopBefore = beforeStore.modules.find((module) => module.displayName === "Workshop Fabricator");

      expect(workshopBefore).toBeDefined();
      if (!workshopBefore) {
        return;
      }

      const result = await runCommand(["module", "set-status", workshopBefore.id, "damaged"]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(workshopBefore.id);
      expect(result.stdout).toContain("damaged");
      expect(result.stdout).toContain("1 kW");

      const afterStore = await readJson<{ modules: ModuleRecord[] }>(moduleStorePath);
      const workshopAfter = afterStore.modules.find((module) => module.id === workshopBefore.id);

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

    await withWorkspace(async (cwd) => {
      await runCommand(["register", "--name", "Adrians Land"]);

      const tick = await runCommand(["tick", "1"]);

      expect(tick.exitCode).toBe(0);
      expect(tick.stdout).toContain("Ran 1 tick.");

      const moduleStorePath = join(cwd, ".habitat", "modules.json");
      const moduleStore = await readJson<{ modules: ModuleRecord[] }>(moduleStorePath);
      const battery = moduleStore.modules.find((module) => module.displayName === "Basic Battery");

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

    await withWorkspace(async (cwd) => {
      await runCommand(["register", "--name", "Adrians Land"]);

      const moduleStorePath = join(cwd, ".habitat", "modules.json");
      const moduleStore = await readJson<{ modules: ModuleRecord[] }>(moduleStorePath);
      const battery = moduleStore.modules.find((module) => module.displayName === "Basic Battery");

      expect(battery).toBeDefined();
      if (!battery) {
        return;
      }

      battery.runtimeAttributes.currentEnergyKwh = 0.00205;
      await writeJson(moduleStorePath, moduleStore);

      const tick = await runCommand(["tick", "1"]);

      expect(tick.exitCode).toBe(0);

      const updatedStore = await readJson<{ modules: ModuleRecord[] }>(moduleStorePath);
      const commandModule = updatedStore.modules.find((module) => module.displayName === "Command Module");
      const lifeSupport = updatedStore.modules.find((module) => module.displayName === "Life Support");
      const workshop = updatedStore.modules.find((module) => module.displayName === "Workshop Fabricator");
      const suitport = updatedStore.modules.find((module) => module.displayName === "Basic Suitport");
      const updatedBattery = updatedStore.modules.find((module) => module.displayName === "Basic Battery");

      expect(commandModule?.runtimeAttributes.status).toBe("active");
      expect(lifeSupport?.runtimeAttributes.status).toBe("active");
      expect(workshop?.runtimeAttributes.status).toBe("offline");
      expect(suitport?.runtimeAttributes.status).toBe("offline");
      expect(updatedBattery?.runtimeAttributes.currentEnergyKwh).toBe(0);
    });
  });

  test("unregister removes local module storage", async () => {
    installMockFetch();

    await withWorkspace(async (cwd) => {
      await runCommand(["register", "--name", "Adrians Land"]);
      const unregister = await runCommand(["unregister"]);

      expect(unregister.exitCode).toBe(0);
      expect(unregister.stdout).toContain('Unregistered "Adrians Land" from Kepler.');
      await expect(readFile(join(cwd, ".habitat", "registration.json"), "utf8")).rejects.toThrow();
      await expect(readFile(join(cwd, ".habitat", "modules.json"), "utf8")).rejects.toThrow();
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
