import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Command } from "commander";
import {
  getEnergyCostPerTickKwh,
  getModuleCurrentPowerDrawKw,
  getModulePowerState,
  simulatePowerTicks,
  type ModuleRecord,
} from "./power";

type ModuleStore = {
  modules: ModuleRecord[];
};

type RegistrationRecord = {
  habitatUuid: string;
  displayName: string;
  habitatId: string;
  baseUrl: string;
  registeredAt: string;
  lastSyncedAt: string;
  starterModules: ModuleRecord[];
  blueprints: unknown[];
  lastStatus?: Habitat;
};

type Habitat = {
  id: string;
  habitatSlug: string;
  displayName: string;
  catalogVersion: string;
  status: string;
  lastSeenAt?: string | null;
};

type HabitatRegistrationResponse = {
  habitatId: string;
  starterModules: ModuleRecord[];
  blueprints: unknown[];
};

type HabitatResponse = {
  habitat: Habitat;
};

type BlueprintOutput = {
  itemType?: string;
  moduleType?: string;
  quantity?: number;
};

type BlueprintRequiredFacility = {
  moduleType?: string;
  minimumLevel?: number;
};

type BlueprintRecord = {
  id: string;
  blueprintId: string;
  displayName: string;
  description?: string;
  status?: string;
  output?: BlueprintOutput;
  inputs?: Record<string, number>;
  productionCost?: Record<string, number>;
  requiredFacility?: BlueprintRequiredFacility;
  buildTicks?: number;
  prerequisites?: string[];
  unlocks?: string[];
  repeatable?: boolean;
  runtimeAttributes?: Record<string, unknown>;
  capabilities?: string[];
};

type BlueprintCatalogResponse = {
  blueprints: BlueprintRecord[];
};

type BlueprintResponse = {
  blueprint: BlueprintRecord;
};

type ResourceCatalogEntry = {
  resourceType: string;
  displayName?: string;
  description?: string;
  category?: string;
};

type ResourceCatalogResponse = {
  resources: ResourceCatalogEntry[];
};

const DEFAULT_BASE_URL = "https://planet.turingguild.com";

const program = new Command();
program.exitOverride();

type OutputWriters = {
  stdout: (message: string) => void;
  stderr: (message: string) => void;
};

const defaultOutputWriters: OutputWriters = {
  stdout: (message) => console.log(message),
  stderr: (message) => console.error(message),
};

let outputWriters = defaultOutputWriters;

function writeStdout(message: string) {
  outputWriters.stdout(message);
}

function writeStderr(message: string) {
  outputWriters.stderr(message);
}

function fail(message: string): never {
  throw new Error(message);
}

function getRegistrationFile() {
  return join(process.cwd(), ".habitat", "registration.json");
}

function getModuleFile() {
  return join(process.cwd(), ".habitat", "modules.json");
}

function getBaseUrl() {
  const value =
    Bun.env.KEPLER_BASE_URL ??
    Bun.env.KEPLER_WORLD_BASE_URL ??
    Bun.env.PLANET_SERVER_PUBLIC_BASE_URL ??
    DEFAULT_BASE_URL;

  return value.replace(/\/+$/, "");
}

function getToken() {
  return Bun.env.KEPLER_PLANET_TOKEN ?? Bun.env.KEPLER_WORLD_TOKEN ?? Bun.env.PLANET_TOKEN;
}

function requireToken() {
  const token = getToken();

  if (!token) {
    fail("Missing Kepler token. Set KEPLER_PLANET_TOKEN in your environment or .env file.");
  }

  return token;
}

async function readRegistration() {
  try {
    const content = await readFile(getRegistrationFile(), "utf8");
    return JSON.parse(content) as RegistrationRecord;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

async function writeRegistration(record: RegistrationRecord) {
  const file = getRegistrationFile();
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(record, null, 2)}\n`, "utf8");
}

async function removeRegistration() {
  await rm(getRegistrationFile(), { force: true });
}

async function readModules() {
  try {
    const content = await readFile(getModuleFile(), "utf8");
    const store = JSON.parse(content) as ModuleStore;
    return store.modules ?? [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }

    throw error;
  }
}

async function writeModules(modules: ModuleRecord[]) {
  const file = getModuleFile();
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify({ modules }, null, 2)}\n`, "utf8");
}

async function removeModules() {
  await rm(getModuleFile(), { force: true });
}

async function readJsonResponse<T>(response: Response) {
  const text = await response.text();

  if (!response.ok) {
    const details = text ? ` ${text}` : "";
    fail(`Kepler request failed with ${response.status}.${details}`);
  }

  return text ? (JSON.parse(text) as T) : ({} as T);
}

async function keplerRequest<T>(path: string, options: RequestInit = {}, baseUrl = getBaseUrl()) {
  let response: Response;

  try {
    response = await fetch(`${baseUrl}${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${requireToken()}`,
        Accept: "application/json",
        ...options.headers,
      },
    });
  } catch (error) {
    const details = error instanceof Error ? ` ${error.message}` : "";
    fail(`Unable to reach Kepler at ${baseUrl}.${details}`);
  }

  return readJsonResponse<T>(response);
}

async function keplerCatalogRequest<T>(path: string, notFoundMessage: string, baseUrl = getBaseUrl()) {
  let response: Response;

  try {
    response = await fetch(`${baseUrl}${path}`, {
      headers: {
        Authorization: `Bearer ${requireToken()}`,
        Accept: "application/json",
      },
    });
  } catch (error) {
    const details = error instanceof Error ? ` ${error.message}` : "";
    fail(`Unable to reach Kepler at ${baseUrl}.${details}`);
  }

  if (response.status === 404) {
    fail(notFoundMessage);
  }

  return readJsonResponse<T>(response);
}

function parseList(value?: string) {
  if (!value) {
    return [];
  }

  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseRuntimeAttributes(value?: string) {
  if (!value) {
    return {};
  }

  try {
    const parsed = JSON.parse(value);

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      fail("Runtime attributes must be a JSON object.");
    }

    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof SyntaxError) {
      fail("Runtime attributes must be valid JSON.");
    }

    throw error;
  }
}

function printRegistration(record: RegistrationRecord) {
  writeStdout(`Habitat ID: ${record.habitatId}`);
  writeStdout(`Habitat UUID: ${record.habitatUuid}`);
  writeStdout(`Display Name: ${record.displayName}`);
  writeStdout(`Base URL: ${record.baseUrl}`);
  writeStdout(`Registered At: ${record.registeredAt}`);
  writeStdout(`Starter Modules: ${record.starterModules.length}`);
  writeStdout(`Blueprints: ${record.blueprints.length}`);
}

function printHabitat(habitat: Habitat, moduleCount: number) {
  writeStdout(`Habitat ID: ${habitat.id}`);
  writeStdout(`Slug: ${habitat.habitatSlug}`);
  writeStdout(`Display Name: ${habitat.displayName}`);
  writeStdout(`Catalog Version: ${habitat.catalogVersion}`);
  writeStdout(`Status: ${habitat.status}`);
  writeStdout(`Last Seen At: ${habitat.lastSeenAt ?? "never"}`);
  writeStdout(`Modules: ${moduleCount}`);
}

function printModuleSummary(module: ModuleRecord) {
  writeStdout(`${module.displayName} | blueprint=${module.blueprintId} | id=${module.id} | capabilities=${module.capabilities.length}`);
}

function printModuleDetails(module: ModuleRecord) {
  writeStdout(`Display Name: ${module.displayName}`);
  writeStdout(`ID: ${module.id}`);
  writeStdout(`Blueprint ID: ${module.blueprintId}`);
  writeStdout(`Connected To: ${module.connectedTo.length === 0 ? "none" : module.connectedTo.join(", ")}`);
  writeStdout(`Capabilities: ${module.capabilities.length === 0 ? "none" : module.capabilities.join(", ")}`);
  writeStdout(`Runtime Attributes: ${JSON.stringify(module.runtimeAttributes, null, 2)}`);
}

function formatNumber(value: number) {
  if (!Number.isFinite(value)) {
    return "0";
  }

  const rounded = Number.parseFloat(value.toFixed(6));
  return `${rounded}`;
}

function printModulePowerStatus(modules: ModuleRecord[]) {
  const rows = modules.map((module) => {
    const state = getModulePowerState(module);
    const drawKw = getModuleCurrentPowerDrawKw(module);

    return {
      name: module.displayName,
      state,
      drawKw,
    };
  });

  const nameWidth = Math.max("Module".length, ...rows.map((row) => row.name.length));
  const stateWidth = Math.max("State".length, ...rows.map((row) => row.state.length));
  const drawWidth = Math.max("Power Draw (kW)".length, ...rows.map((row) => formatNumber(row.drawKw).length));

  writeStdout(
    `${"Module".padEnd(nameWidth)}  ${"State".padEnd(stateWidth)}  ${"Power Draw (kW)".padStart(drawWidth)}`,
  );
  writeStdout(
    `${"-".repeat(nameWidth)}  ${"-".repeat(stateWidth)}  ${"-".repeat(drawWidth)}`,
  );

  let totalPowerDrawKw = 0;

  for (const row of rows) {
    totalPowerDrawKw += row.drawKw;
    writeStdout(
      `${row.name.padEnd(nameWidth)}  ${row.state.padEnd(stateWidth)}  ${formatNumber(row.drawKw).padStart(drawWidth)}`,
    );
  }

  const tickEnergyCostKwh = getEnergyCostPerTickKwh(totalPowerDrawKw);

  writeStdout(
    `Total current power draw: ${formatNumber(totalPowerDrawKw)} kW | Energy cost per tick: ${formatNumber(tickEnergyCostKwh)} kWh`,
  );
}

function printModuleStatusChange(module: ModuleRecord) {
  const currentPowerDrawKw = getModuleCurrentPowerDrawKw(module);
  writeStdout(
    `Module ${module.id} is now ${getModulePowerState(module)} (${formatNumber(currentPowerDrawKw)} kW).`,
  );
}

function formatKeyValueRecord(values?: Record<string, number>) {
  if (!values || Object.keys(values).length === 0) {
    return "none";
  }

  return Object.entries(values)
    .map(([key, value]) => `${key}=${value}`)
    .join(", ");
}

function formatBlueprintOutput(output?: BlueprintOutput) {
  if (!output) {
    return "n/a";
  }

  const itemType = output.itemType ?? "item";
  const moduleType = output.moduleType ?? "unknown";
  const quantity = output.quantity ?? 1;
  return `${quantity} ${moduleType} (${itemType})`;
}

function formatRequiredFacility(requiredFacility?: BlueprintRequiredFacility) {
  if (!requiredFacility?.moduleType) {
    return "none";
  }

  const level = requiredFacility.minimumLevel ?? 1;
  return `${requiredFacility.moduleType} lvl ${level}`;
}

function printBlueprintList(blueprints: BlueprintRecord[]) {
  const rows = blueprints.map((blueprint) => ({
    id: blueprint.blueprintId,
    name: blueprint.displayName,
    facility: formatRequiredFacility(blueprint.requiredFacility),
    ticks: `${blueprint.buildTicks ?? 0}`,
  }));

  const idWidth = Math.max("Blueprint ID".length, ...rows.map((row) => row.id.length));
  const nameWidth = Math.max("Name".length, ...rows.map((row) => row.name.length));
  const facilityWidth = Math.max("Facility".length, ...rows.map((row) => row.facility.length));
  const ticksWidth = Math.max("Ticks".length, ...rows.map((row) => row.ticks.length));

  writeStdout(
    `${"Blueprint ID".padEnd(idWidth)}  ${"Name".padEnd(nameWidth)}  ${"Facility".padEnd(facilityWidth)}  ${"Ticks".padStart(ticksWidth)}`,
  );
  writeStdout(
    `${"-".repeat(idWidth)}  ${"-".repeat(nameWidth)}  ${"-".repeat(facilityWidth)}  ${"-".repeat(ticksWidth)}`,
  );

  for (const row of rows) {
    writeStdout(
      `${row.id.padEnd(idWidth)}  ${row.name.padEnd(nameWidth)}  ${row.facility.padEnd(facilityWidth)}  ${row.ticks.padStart(ticksWidth)}`,
    );
  }
}

function printBlueprintDetails(blueprint: BlueprintRecord) {
  writeStdout(`Blueprint ID: ${blueprint.blueprintId}`);
  writeStdout(`Record ID: ${blueprint.id}`);
  writeStdout(`Name: ${blueprint.displayName}`);
  writeStdout(`Status: ${blueprint.status ?? "unknown"}`);
  writeStdout(`Description: ${blueprint.description ?? "none"}`);
  writeStdout(`Output: ${formatBlueprintOutput(blueprint.output)}`);
  writeStdout(`Required Facility: ${formatRequiredFacility(blueprint.requiredFacility)}`);
  writeStdout(`Build Ticks: ${blueprint.buildTicks ?? 0}`);
  writeStdout(`Inputs: ${formatKeyValueRecord(blueprint.inputs)}`);
  writeStdout(`Production Cost: ${formatKeyValueRecord(blueprint.productionCost)}`);
  writeStdout(`Prerequisites: ${blueprint.prerequisites?.length ? blueprint.prerequisites.join(", ") : "none"}`);
  writeStdout(`Unlocks: ${blueprint.unlocks?.length ? blueprint.unlocks.join(", ") : "none"}`);
  writeStdout(`Repeatable: ${blueprint.repeatable === false ? "no" : "yes"}`);
}

function printResourceCatalog(resources: ResourceCatalogEntry[]) {
  writeStdout("Kepler resource catalog: possible resource types in the Kepler world.");
  writeStdout("This is not your habitat inventory.");

  const rows = resources.map((resource) => ({
    type: resource.resourceType,
    name: resource.displayName ?? resource.resourceType,
    category: resource.category ?? "uncategorized",
  }));

  const typeWidth = Math.max("Resource Type".length, ...rows.map((row) => row.type.length));
  const nameWidth = Math.max("Name".length, ...rows.map((row) => row.name.length));
  const categoryWidth = Math.max("Category".length, ...rows.map((row) => row.category.length));

  writeStdout(
    `${"Resource Type".padEnd(typeWidth)}  ${"Name".padEnd(nameWidth)}  ${"Category".padEnd(categoryWidth)}`,
  );
  writeStdout(
    `${"-".repeat(typeWidth)}  ${"-".repeat(nameWidth)}  ${"-".repeat(categoryWidth)}`,
  );

  for (const row of rows) {
    writeStdout(
      `${row.type.padEnd(typeWidth)}  ${row.name.padEnd(nameWidth)}  ${row.category.padEnd(categoryWidth)}`,
    );
  }

  writeStdout("Blueprint requirements may refer to these resource types later.");
  writeStdout("Local inventory will be tracked separately in habitat files later.");
}

async function requireRegistration() {
  const record = await readRegistration();

  if (!record) {
    fail('Not registered with Kepler. Run habitat register --name "<habitat name>" to register.');
  }

  return record;
}

function findModule(modules: ModuleRecord[], displayName: string) {
  return modules.find((module) => module.displayName === displayName);
}

program
  .name("habitat")
  .description("Register this Habitat CLI with Kepler, manage its registration, and simulate power ticks.")
  .version("0.1.0")
  .showHelpAfterError("(run `habitat --help` for more information)");

program
  .command("register")
  .description("Register this habitat with Kepler.")
  .requiredOption("--name <habitatName>", "habitat display name")
  .action(async (options: { name: string }) => {
    const existing = await readRegistration();

    if (existing) {
      fail(`Already registered as "${existing.displayName}" (${existing.habitatId}). Run habitat status to inspect it.`);
    }

    const habitatUuid = crypto.randomUUID();
    const displayName = options.name;
    const baseUrl = getBaseUrl();
    const response = await keplerRequest<HabitatRegistrationResponse>("/habitats/register", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        habitatUuid,
        displayName,
      }),
    });

    const now = new Date().toISOString();
    const record: RegistrationRecord = {
      habitatUuid,
      displayName,
      habitatId: response.habitatId,
      baseUrl,
      registeredAt: now,
      lastSyncedAt: now,
      starterModules: response.starterModules,
      blueprints: response.blueprints,
    };

    try {
      await writeModules(response.starterModules);
      await writeRegistration(record);
    } catch (error) {
      await removeModules();
      throw error;
    }

    writeStdout("Registered with Kepler.");
    printRegistration(record);
  });

program
  .command("status")
  .description("Show this habitat's Kepler registration status.")
  .action(async () => {
    const record = await readRegistration();

    if (!record) {
      writeStdout("Not registered with Kepler.");
      writeStdout('Run habitat register --name "<habitat name>" to register.');
      return;
    }

    const response = await keplerRequest<HabitatResponse>(`/habitats/${record.habitatId}`, {}, record.baseUrl);
    const modules = await readModules();
    const nextRecord: RegistrationRecord = {
      ...record,
      displayName: response.habitat.displayName,
      lastSyncedAt: new Date().toISOString(),
      lastStatus: response.habitat,
    };

    await writeRegistration(nextRecord);
    printHabitat(response.habitat, modules.length);
  });

program
  .command("unregister")
  .description("Delete this habitat registration from Kepler.")
  .action(async () => {
    const record = await readRegistration();

    if (!record) {
      writeStdout("Not registered with Kepler.");
      return;
    }

    await keplerRequest(`/habitats/${record.habitatId}`, { method: "DELETE" }, record.baseUrl);
    await removeRegistration();
    await removeModules();
    writeStdout(`Unregistered "${record.displayName}" from Kepler.`);
  });

program
  .command("tick")
  .description("Advance the habitat power simulation by one or more one-second ticks.")
  .argument("<count>", "number of one-second ticks to run")
  .action(async (count: string) => {
    await requireRegistration();

    const parsedCount = Number.parseInt(count, 10);

    if (!Number.isInteger(parsedCount) || parsedCount <= 0 || `${parsedCount}` !== count.trim()) {
      fail("Tick count must be a positive integer.");
    }

    let modules = await readModules();

    for (let tick = 0; tick < parsedCount; tick += 1) {
      const result = simulatePowerTicks(modules, 1);
      modules = result.modules;
    }

    await writeModules(modules);

    const batteryModule = modules.find(
      (module) => module.blueprintId === "basic-battery" || module.capabilities.includes("power-storage"),
    );

    writeStdout(`Ran ${parsedCount} tick${parsedCount === 1 ? "" : "s"}.`);

    if (batteryModule && typeof batteryModule.runtimeAttributes.currentEnergyKwh === "number") {
      writeStdout(`Battery energy: ${batteryModule.runtimeAttributes.currentEnergyKwh} kWh`);
    }
  });

const blueprintCommand = program.command("blueprint").description("Read official Kepler blueprint catalog data.");

blueprintCommand
  .command("list")
  .description("List official Kepler blueprints.")
  .action(async () => {
    const response = await keplerCatalogRequest<BlueprintCatalogResponse>(
      "/catalog/blueprints",
      "Kepler blueprint catalog was not found.",
    );
    const blueprints = response.blueprints ?? [];

    if (blueprints.length === 0) {
      writeStdout("No blueprints found.");
      return;
    }

    printBlueprintList(blueprints);
  });

blueprintCommand
  .command("show")
  .description("Show one official Kepler blueprint.")
  .argument("<blueprint-id>", "blueprint id")
  .action(async (blueprintId: string) => {
    const response = await keplerCatalogRequest<BlueprintResponse>(
      `/catalog/blueprints/${encodeURIComponent(blueprintId)}`,
      `Blueprint "${blueprintId}" was not found in the Kepler catalog.`,
    );

    printBlueprintDetails(response.blueprint);
  });

const resourceCommand = program.command("resource").description("Read official Kepler resource catalog data.");

resourceCommand
  .command("list")
  .description("List official Kepler resource types.")
  .action(async () => {
    const response = await keplerCatalogRequest<ResourceCatalogResponse>(
      "/catalog/resources",
      "Kepler resource catalog was not found.",
    );
    const resources = response.resources ?? [];

    if (resources.length === 0) {
      writeStdout("No resource types found.");
      return;
    }

    printResourceCatalog(resources);
  });

const moduleCommand = program.command("module").description("Manage local habitat modules.");

moduleCommand
  .command("status")
  .description("Show module power states and current draw.")
  .action(async () => {
    await requireRegistration();
    const modules = await readModules();

    if (modules.length === 0) {
      writeStdout("No modules found.");
      return;
    }

    printModulePowerStatus(modules);
  });

moduleCommand
  .command("set-status")
  .description("Set a module's runtime power state.")
  .argument("<module-id>", "module id")
  .argument("<status>", "offline, idle, online, active, or damaged")
  .action(async (moduleId: string, status: string) => {
    await requireRegistration();
    const modules = await readModules();
    const module = modules.find((item) => item.id === moduleId);

    if (!module) {
      fail(`Module with id "${moduleId}" not found.`);
    }

    const allowedStatuses = new Set(["offline", "idle", "online", "active", "damaged"]);

    if (!allowedStatuses.has(status)) {
      fail('Status must be one of: offline, idle, online, active, or damaged.');
    }

    const runtimeAttributes = module.runtimeAttributes as Record<string, unknown>;
    runtimeAttributes.status = status;

    await writeModules(modules);
    printModuleStatusChange(module);
  });

moduleCommand
  .command("create")
  .description("Create a local module.")
  .requiredOption("--name <displayName>", "module display name")
  .requiredOption("--blueprint-id <blueprintId>", "module blueprint id")
  .option("--connected-to <moduleNames>", "comma-separated module names")
  .option("--runtime-attributes <json>", "JSON object of runtime attributes")
  .option("--capabilities <capabilities>", "comma-separated module capabilities")
  .action(async (options: {
    name: string;
    blueprintId: string;
    connectedTo?: string;
    runtimeAttributes?: string;
    capabilities?: string;
  }) => {
    await requireRegistration();
    const modules = await readModules();

    if (findModule(modules, options.name)) {
      fail(`Module "${options.name}" already exists.`);
    }

    const module: ModuleRecord = {
      id: `module_${crypto.randomUUID()}`,
      blueprintId: options.blueprintId,
      displayName: options.name,
      connectedTo: parseList(options.connectedTo),
      runtimeAttributes: parseRuntimeAttributes(options.runtimeAttributes),
      capabilities: parseList(options.capabilities),
    };

    modules.push(module);
    await writeModules(modules);
    writeStdout(`Created module "${module.displayName}".`);
    printModuleDetails(module);
  });

moduleCommand
  .command("list")
  .description("List local modules.")
  .action(async () => {
    await requireRegistration();
    const modules = await readModules();

    if (modules.length === 0) {
      writeStdout("No modules found.");
      return;
    }

    for (const module of modules) {
      printModuleSummary(module);
    }
  });

moduleCommand
  .command("show")
  .description("Show one module.")
  .argument("<displayName>", "module display name")
  .action(async (displayName: string) => {
    await requireRegistration();
    const modules = await readModules();
    const module = findModule(modules, displayName);

    if (!module) {
      fail(`Module "${displayName}" not found.`);
    }

    printModuleDetails(module);
  });

moduleCommand
  .command("update")
  .description("Update a module.")
  .argument("<displayName>", "module display name")
  .option("--name <displayName>", "new module display name")
  .option("--blueprint-id <blueprintId>", "new module blueprint id")
  .option("--connected-to <moduleNames>", "comma-separated module names")
  .option("--runtime-attributes <json>", "JSON object of runtime attributes")
  .option("--capabilities <capabilities>", "comma-separated module capabilities")
  .action(async (
    displayName: string,
    options: {
      name?: string;
      blueprintId?: string;
      connectedTo?: string;
      runtimeAttributes?: string;
      capabilities?: string;
    },
  ) => {
    await requireRegistration();
    const modules = await readModules();
    const module = findModule(modules, displayName);

    if (!module) {
      fail(`Module "${displayName}" not found.`);
    }

    if (!options.name && !options.blueprintId && !options.connectedTo && !options.runtimeAttributes && !options.capabilities) {
      fail("Provide at least one field to update with --name, --blueprint-id, --connected-to, --runtime-attributes, or --capabilities.");
    }

    if (options.name && options.name !== displayName && findModule(modules, options.name)) {
      fail(`Module "${options.name}" already exists.`);
    }

    module.displayName = options.name ?? module.displayName;
    module.blueprintId = options.blueprintId ?? module.blueprintId;
    if (options.connectedTo !== undefined) {
      module.connectedTo = parseList(options.connectedTo);
    }
    if (options.runtimeAttributes !== undefined) {
      module.runtimeAttributes = parseRuntimeAttributes(options.runtimeAttributes);
    }
    if (options.capabilities !== undefined) {
      module.capabilities = parseList(options.capabilities);
    }

    await writeModules(modules);
    writeStdout(`Updated module "${module.displayName}".`);
    printModuleDetails(module);
  });

moduleCommand
  .command("delete")
  .description("Delete a module.")
  .argument("<displayName>", "module display name")
  .action(async (displayName: string) => {
    await requireRegistration();
    const modules = await readModules();
    const index = modules.findIndex((module) => module.displayName === displayName);

    if (index === -1) {
      fail(`Module "${displayName}" not found.`);
    }

    modules.splice(index, 1);
    await writeModules(modules);
    writeStdout(`Deleted module "${displayName}".`);
  });

moduleCommand.on("command:*", ([unknownCommand]) => {
  fail(`Unknown module command: ${unknownCommand}\nRun \`habitat module --help\` to see available module commands.`);
});

program.on("command:*", ([unknownCommand]) => {
  fail(`Unknown command: ${unknownCommand}\nRun \`habitat --help\` to see available commands.`);
});

export async function runCli(argv = process.argv.slice(2), writers?: Partial<OutputWriters>) {
  const previousOutputWriters = outputWriters;
  outputWriters = writers
    ? {
        stdout: writers.stdout ?? defaultOutputWriters.stdout,
        stderr: writers.stderr ?? defaultOutputWriters.stderr,
      }
    : defaultOutputWriters;

  try {
    await program.parseAsync(argv, { from: "user" });
    return 0;
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as { code?: string }).code &&
      ((error as { code?: string }).code === "commander.helpDisplayed" ||
        (error as { code?: string }).code === "commander.version")
    ) {
      return 0;
    }

    const message = error instanceof Error ? error.message : String(error);
    writeStderr(message);
    return 1;
  } finally {
    outputWriters = previousOutputWriters;
  }
}

if (import.meta.main) {
  const exitCode = await runCli();

  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}
