import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Command } from "commander";
import {
  advanceConstructionJobs,
  buildConstructionPlan,
  cancelConstruction,
  spendInventory,
  startConstruction,
  type BlueprintRecord,
  type BlueprintOutput,
  type BlueprintRequiredFacility,
  type ConstructionPlan,
  type ConstructionJob,
  type InventoryStore,
} from "./construction";
import { findModuleByReference, getModuleReference } from "./module-refs";
import {
  getEnergyCostPerTickKwh,
  getModuleCurrentPowerDrawKw,
  getModulePowerState,
  simulatePowerTicks,
  type ModuleRecord,
} from "./power";
import {
  applySolarCharging,
  formatSolarStatus,
  type SolarIrradiance,
  type SolarIrradianceResponse,
} from "./solar";

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

function getInventoryFile() {
  return join(process.cwd(), ".habitat", "inventory.json");
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

async function readInventory() {
  try {
    const content = await readFile(getInventoryFile(), "utf8");
    const store = JSON.parse(content) as InventoryStore;
    return {
      resources: store.resources ?? {},
    } satisfies InventoryStore;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        resources: {},
      } satisfies InventoryStore;
    }

    throw error;
  }
}

async function writeInventory(inventory: InventoryStore) {
  const file = getInventoryFile();
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(inventory, null, 2)}\n`, "utf8");
}

async function removeInventory() {
  await rm(getInventoryFile(), { force: true });
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

async function readSolarIrradiance() {
  const response = await keplerRequest<SolarIrradianceResponse>("/world/solar-irradiance");
  return response.solarIrradiance;
}

async function tryReadSolarIrradiance() {
  try {
    return {
      irradiance: await readSolarIrradiance(),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      irradiance: null,
      error: message,
    };
  }
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
  const rows = [
    { label: "Habitat ID", value: habitat.id },
    { label: "Slug", value: habitat.habitatSlug },
    { label: "Display Name", value: habitat.displayName },
    { label: "Catalog Version", value: habitat.catalogVersion },
    { label: "Status", value: habitat.status },
    { label: "Last Seen At", value: habitat.lastSeenAt ?? "never" },
    { label: "Modules", value: `${moduleCount}` },
  ];

  const labelWidth = Math.max("Field".length, ...rows.map((row) => row.label.length));
  const valueWidth = Math.max("Value".length, ...rows.map((row) => row.value.length));

  writeStdout(`${"Field".padEnd(labelWidth)}  ${"Value".padEnd(valueWidth)}`);
  writeStdout(`${"-".repeat(labelWidth)}  ${"-".repeat(valueWidth)}`);

  for (const row of rows) {
    writeStdout(`${row.label.padEnd(labelWidth)}  ${row.value.padEnd(valueWidth)}`);
  }
}

function printModuleList(modules: ModuleRecord[]) {
  const rows = modules.map((module) => {
    const state = (module.runtimeAttributes as Record<string, unknown>).status;

    return {
      reference: getModuleReference(modules, module),
      name: module.displayName,
      blueprintId: module.blueprintId,
      state: typeof state === "string" ? state : "offline",
      capabilities: `${module.capabilities.length}`,
    };
  });

  const refWidth = Math.max("Module Ref".length, ...rows.map((row) => row.reference.length));
  const nameWidth = Math.max("Name".length, ...rows.map((row) => row.name.length));
  const blueprintWidth = Math.max("Blueprint".length, ...rows.map((row) => row.blueprintId.length));
  const stateWidth = Math.max("State".length, ...rows.map((row) => row.state.length));
  const capabilitiesWidth = Math.max("Caps".length, ...rows.map((row) => row.capabilities.length));

  writeStdout("Local modules: module instances currently owned by this habitat.");
  writeStdout(
    `${"Module Ref".padEnd(refWidth)}  ${"Name".padEnd(nameWidth)}  ${"Blueprint".padEnd(blueprintWidth)}  ${"State".padEnd(stateWidth)}  ${"Caps".padStart(capabilitiesWidth)}`,
  );
  writeStdout(
    `${"-".repeat(refWidth)}  ${"-".repeat(nameWidth)}  ${"-".repeat(blueprintWidth)}  ${"-".repeat(stateWidth)}  ${"-".repeat(capabilitiesWidth)}`,
  );

  for (const row of rows) {
    writeStdout(
      `${row.reference.padEnd(refWidth)}  ${row.name.padEnd(nameWidth)}  ${row.blueprintId.padEnd(blueprintWidth)}  ${row.state.padEnd(stateWidth)}  ${row.capabilities.padStart(capabilitiesWidth)}`,
    );
  }
}

function printModuleDetails(module: ModuleRecord, modules: ModuleRecord[]) {
  const reference = getModuleReference(modules, module);
  writeStdout(`Reference: ${reference}`);
  writeStdout(`Display Name: ${module.displayName}`);
  writeStdout(`ID: ${module.id}`);
  writeStdout(`Blueprint ID: ${module.blueprintId}`);
  writeStdout(`Connected To: ${module.connectedTo.length === 0 ? "none" : module.connectedTo.join(", ")}`);
  writeStdout(`Capabilities: ${module.capabilities.length === 0 ? "none" : module.capabilities.join(", ")}`);
  const currentStatus = (module.runtimeAttributes as Record<string, unknown>).status;
  if (typeof currentStatus === "string") {
    writeStdout(`State: ${currentStatus}`);
  }
  if (module.blueprintId === "basic-battery") {
    const batteryAttributes = module.runtimeAttributes as Record<string, unknown>;
    if (typeof batteryAttributes.currentEnergyKwh === "number") {
      writeStdout(`Battery Energy: ${batteryAttributes.currentEnergyKwh} kWh`);
    }
    if (typeof batteryAttributes.energyStorageKwh === "number") {
      writeStdout(`Battery Capacity: ${batteryAttributes.energyStorageKwh} kWh`);
    }
  }
  if (module.capabilities.includes("solar-generation") || module.blueprintId.includes("solar")) {
    const solarAttributes = module.runtimeAttributes as Record<string, unknown>;
    if (typeof solarAttributes.powerGenerationKw === "number") {
      writeStdout(`Solar Generation: ${solarAttributes.powerGenerationKw} kW`);
    }
  }
  const constructionJob = (module.runtimeAttributes as Record<string, unknown>).constructionJob as ConstructionJob | undefined;
  if (constructionJob) {
    writeStdout(`Construction Job: ${constructionJob.blueprintId}`);
    writeStdout(`Construction Output: ${constructionJob.outputModuleRef}`);
    writeStdout(`Remaining Ticks: ${constructionJob.remainingTicks}/${constructionJob.buildTicks}`);
  }
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
    const reference = getModuleReference(modules, module);

    return {
      reference,
      name: module.displayName,
      state,
      drawKw,
    };
  });

  const refWidth = Math.max("Module Ref".length, ...rows.map((row) => row.reference.length));
  const nameWidth = Math.max("Module".length, ...rows.map((row) => row.name.length));
  const stateWidth = Math.max("State".length, ...rows.map((row) => row.state.length));
  const drawWidth = Math.max("Power Draw (kW)".length, ...rows.map((row) => formatNumber(row.drawKw).length));

  writeStdout(
    `${"Module Ref".padEnd(refWidth)}  ${"Module".padEnd(nameWidth)}  ${"State".padEnd(stateWidth)}  ${"Power Draw (kW)".padStart(drawWidth)}`,
  );
  writeStdout(
    `${"-".repeat(refWidth)}  ${"-".repeat(nameWidth)}  ${"-".repeat(stateWidth)}  ${"-".repeat(drawWidth)}`,
  );

  let totalPowerDrawKw = 0;

  for (const row of rows) {
    totalPowerDrawKw += row.drawKw;
    writeStdout(
      `${row.reference.padEnd(refWidth)}  ${row.name.padEnd(nameWidth)}  ${row.state.padEnd(stateWidth)}  ${formatNumber(row.drawKw).padStart(drawWidth)}`,
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

function printInventory(inventory: InventoryStore) {
  const entries = Object.entries(inventory.resources).sort(([left], [right]) => left.localeCompare(right));

  if (entries.length === 0) {
    writeStdout("No local inventory yet.");
    writeStdout("This is separate from the Kepler resource catalog.");
    return;
  }

  writeStdout("Local inventory: resources this habitat currently owns.");
  const typeWidth = Math.max("Resource Type".length, ...entries.map(([resourceType]) => resourceType.length));
  const qtyWidth = Math.max("Quantity".length, ...entries.map(([, amount]) => `${amount}`.length));

  writeStdout(`${"Resource Type".padEnd(typeWidth)}  ${"Quantity".padStart(qtyWidth)}`);
  writeStdout(`${"-".repeat(typeWidth)}  ${"-".repeat(qtyWidth)}`);

  for (const [resourceType, amount] of entries) {
    writeStdout(`${resourceType.padEnd(typeWidth)}  ${`${amount}`.padStart(qtyWidth)}`);
  }
}

function printConstructionPlan(plan: ConstructionPlan, dryRun: boolean) {
  writeStdout(dryRun ? `Construction dry run for ${plan.blueprintId}` : `Construction checks for ${plan.blueprintId}`);
  for (const check of plan.checks) {
    writeStdout(`${check.ok ? "[ok]" : "[x]"} ${check.label}: ${check.details}`);
  }
  writeStdout(`Would create: ${plan.outputModuleRef}`);
  writeStdout(`Resources to spend: ${formatKeyValueRecord(plan.resourcesToSpend)}`);
  writeStdout(`Build ticks: ${plan.buildTicks}`);
  writeStdout(`Construction can start: ${plan.canStart ? "yes" : "no"}`);
}

function printConstructionStatus(modules: ModuleRecord[]) {
  const facilitiesWithJobs = modules
    .map((module) => ({
      module,
      job: (module.runtimeAttributes as Record<string, unknown>).constructionJob as ConstructionJob | undefined,
    }))
    .filter((entry): entry is { module: ModuleRecord; job: ConstructionJob } => Boolean(entry.job));

  if (facilitiesWithJobs.length === 0) {
    writeStdout("No active construction jobs.");
    return;
  }

  const rows = facilitiesWithJobs.map(({ module, job }) => ({
    facility: getModuleReference(modules, module),
    blueprintId: job.blueprintId,
    output: job.outputModuleRef,
    remaining: `${job.remainingTicks}/${job.buildTicks}`,
  }));

  const facilityWidth = Math.max("Facility".length, ...rows.map((row) => row.facility.length));
  const blueprintWidth = Math.max("Blueprint".length, ...rows.map((row) => row.blueprintId.length));
  const outputWidth = Math.max("Output Module".length, ...rows.map((row) => row.output.length));
  const remainingWidth = Math.max("Remaining".length, ...rows.map((row) => row.remaining.length));

  writeStdout(
    `${"Facility".padEnd(facilityWidth)}  ${"Blueprint".padEnd(blueprintWidth)}  ${"Output Module".padEnd(outputWidth)}  ${"Remaining".padEnd(remainingWidth)}`,
  );
  writeStdout(
    `${"-".repeat(facilityWidth)}  ${"-".repeat(blueprintWidth)}  ${"-".repeat(outputWidth)}  ${"-".repeat(remainingWidth)}`,
  );

  for (const row of rows) {
    writeStdout(
      `${row.facility.padEnd(facilityWidth)}  ${row.blueprintId.padEnd(blueprintWidth)}  ${row.output.padEnd(outputWidth)}  ${row.remaining.padEnd(remainingWidth)}`,
    );
  }
}

function printSolarChargeSummary(generatedKwh: number, irradiance?: SolarIrradiance | null, reason?: string) {
  if (generatedKwh > 0) {
    const condition = irradiance?.condition ?? "unknown";
    const irradianceWPerM2 = typeof irradiance?.wPerM2 === "number" ? irradiance.wPerM2 : 0;
    writeStdout(
      `Solar charging: generated ${formatNumber(generatedKwh)} kWh this tick run at ${formatNumber(irradianceWPerM2)} W/m2 (${condition}).`,
    );
    return;
  }

  if (reason) {
    writeStdout(`Solar charging skipped: ${reason}`);
  } else {
    writeStdout("Solar charging skipped.");
  }
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
  writeStdout("Kepler blueprint catalog: official buildable blueprint definitions.");
  writeStdout("These are catalog entries, not local modules your habitat already owns.");

  const rows = blueprints.map((blueprint) => ({
    id: blueprint.blueprintId,
    name: blueprint.displayName,
    output: formatBlueprintOutput(blueprint.output),
    facility: formatRequiredFacility(blueprint.requiredFacility),
    ticks: `${blueprint.buildTicks ?? 0}`,
    status: blueprint.status ?? "unknown",
  }));

  const idWidth = Math.max("Blueprint ID".length, ...rows.map((row) => row.id.length));
  const nameWidth = Math.max("Name".length, ...rows.map((row) => row.name.length));
  const outputWidth = Math.max("Output".length, ...rows.map((row) => row.output.length));
  const facilityWidth = Math.max("Facility".length, ...rows.map((row) => row.facility.length));
  const ticksWidth = Math.max("Ticks".length, ...rows.map((row) => row.ticks.length));
  const statusWidth = Math.max("Status".length, ...rows.map((row) => row.status.length));
  const topBorder = `┌${"─".repeat(idWidth + 2)}┬${"─".repeat(nameWidth + 2)}┬${"─".repeat(outputWidth + 2)}┬${"─".repeat(facilityWidth + 2)}┬${"─".repeat(ticksWidth + 2)}┬${"─".repeat(statusWidth + 2)}┐`;
  const headerDivider = `├${"─".repeat(idWidth + 2)}┼${"─".repeat(nameWidth + 2)}┼${"─".repeat(outputWidth + 2)}┼${"─".repeat(facilityWidth + 2)}┼${"─".repeat(ticksWidth + 2)}┼${"─".repeat(statusWidth + 2)}┤`;
  const rowDivider = headerDivider;
  const bottomBorder = `└${"─".repeat(idWidth + 2)}┴${"─".repeat(nameWidth + 2)}┴${"─".repeat(outputWidth + 2)}┴${"─".repeat(facilityWidth + 2)}┴${"─".repeat(ticksWidth + 2)}┴${"─".repeat(statusWidth + 2)}┘`;

  writeStdout(topBorder);
  writeStdout(
    `│ ${"Blueprint ID".padEnd(idWidth)} │ ${"Name".padEnd(nameWidth)} │ ${"Output".padEnd(outputWidth)} │ ${"Facility".padEnd(facilityWidth)} │ ${"Ticks".padStart(ticksWidth)} │ ${"Status".padEnd(statusWidth)} │`,
  );
  writeStdout(headerDivider);

  rows.forEach((row, index) => {
    writeStdout(
      `│ ${row.id.padEnd(idWidth)} │ ${row.name.padEnd(nameWidth)} │ ${row.output.padEnd(outputWidth)} │ ${row.facility.padEnd(facilityWidth)} │ ${row.ticks.padStart(ticksWidth)} │ ${row.status.padEnd(statusWidth)} │`,
    );
    writeStdout(index === rows.length - 1 ? bottomBorder : rowDivider);
  });
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
  return findModuleByReference(modules, displayName);
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
    await removeInventory();
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
    const completedModules: string[] = [];
    const solarRead = await tryReadSolarIrradiance();
    let totalSolarGenerationKwh = 0;
    let solarSkipReason = solarRead.error ? `unable to read Kepler solar irradiance. ${solarRead.error}` : undefined;

    for (let tick = 0; tick < parsedCount; tick += 1) {
      const powerResult = simulatePowerTicks(modules, 1);
      const constructionResult = advanceConstructionJobs(powerResult.modules, powerResult.poweredModuleIds);
      const solarResult = applySolarCharging(constructionResult.modules, solarRead.irradiance);
      modules = solarResult.modules;
      totalSolarGenerationKwh += solarResult.generatedKwh;
      if (!solarSkipReason && solarResult.reason) {
        solarSkipReason = solarResult.reason;
      }
      completedModules.push(...constructionResult.completedModules);
    }

    await writeModules(modules);

    const batteryModule = modules.find(
      (module) => module.blueprintId === "basic-battery" || module.capabilities.includes("power-storage"),
    );

    writeStdout(`Ran ${parsedCount} tick${parsedCount === 1 ? "" : "s"}.`);

    if (batteryModule && typeof batteryModule.runtimeAttributes.currentEnergyKwh === "number") {
      writeStdout(`Battery energy: ${batteryModule.runtimeAttributes.currentEnergyKwh} kWh`);
    }

    printSolarChargeSummary(totalSolarGenerationKwh, solarRead.irradiance, solarSkipReason);

    for (const completedModule of completedModules) {
      writeStdout(`Construction completed: ${completedModule}`);
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

const solarCommand = program.command("solar").description("Read current Kepler solar conditions.");

solarCommand
  .command("status")
  .description("Show current solar irradiance from Kepler.")
  .action(async () => {
    const irradiance = await readSolarIrradiance();

    if (!irradiance || typeof irradiance.wPerM2 !== "number") {
      fail("Kepler did not return a usable solar irradiance reading.");
    }

    writeStdout(formatSolarStatus(irradiance));
  });

const inventoryCommand = program.command("inventory").description("Manage local habitat inventory.");

inventoryCommand
  .command("list")
  .description("List local inventory resources.")
  .action(async () => {
    await requireRegistration();
    const inventory = await readInventory();
    printInventory(inventory);
  });

inventoryCommand
  .command("add")
  .description("Add resources to local inventory.")
  .argument("<resource-type>", "resource type")
  .argument("<amount>", "resource quantity")
  .action(async (resourceType: string, amount: string) => {
    await requireRegistration();
    const parsedAmount = Number.parseInt(amount, 10);

    if (!Number.isInteger(parsedAmount) || parsedAmount <= 0 || `${parsedAmount}` !== amount.trim()) {
      fail("Inventory amount must be a positive integer.");
    }

    const inventory = await readInventory();
    inventory.resources[resourceType] = (inventory.resources[resourceType] ?? 0) + parsedAmount;
    await writeInventory(inventory);
    writeStdout(`Added ${parsedAmount} ${resourceType} to local inventory.`);
  });

program
  .command("construct")
  .description("Start local construction from a Kepler blueprint.")
  .argument("<blueprint-id>", "blueprint id")
  .option("--dry-run", "check construction readiness without changing local files")
  .action(async (blueprintId: string, options: { dryRun?: boolean }) => {
    await requireRegistration();
    const [modules, inventory] = await Promise.all([readModules(), readInventory()]);
    const response = await keplerCatalogRequest<BlueprintResponse>(
      `/catalog/blueprints/${encodeURIComponent(blueprintId)}`,
      `Blueprint "${blueprintId}" was not found in the Kepler catalog.`,
    );
    const plan = buildConstructionPlan(response.blueprint, modules, inventory);

    printConstructionPlan(plan, Boolean(options.dryRun));

    if (options.dryRun) {
      return;
    }

    if (!plan.canStart) {
      fail("Construction cannot start.");
    }

    const nextModules = startConstruction(modules, plan);
    const nextInventory = spendInventory(inventory, plan.resourcesToSpend);

    await writeModules(nextModules);
    await writeInventory(nextInventory);
    writeStdout(`Started construction for ${plan.blueprintId}.`);
    writeStdout(`Facility: ${plan.facilityRef}`);
    writeStdout(`Output module: ${plan.outputModuleRef}`);
  });

const constructionCommand = program.command("construction").description("Inspect and manage active construction jobs.");

constructionCommand
  .command("status")
  .description("Show active construction jobs.")
  .action(async () => {
    await requireRegistration();
    const modules = await readModules();
    printConstructionStatus(modules);
  });

constructionCommand
  .command("cancel")
  .description("Cancel an active construction job on a facility.")
  .argument("<facility-ref>", "construction facility reference")
  .action(async (facilityRef: string) => {
    await requireRegistration();
    const modules = await readModules();
    const result = cancelConstruction(modules, facilityRef);
    await writeModules(result.modules);
    writeStdout(`Canceled construction on ${result.facilityRef}.`);
    writeStdout(`No materials were refunded. ${result.canceledJob} was not created.`);
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
    const module = findModuleByReference(modules, moduleId);

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
    printModuleDetails(module, modules);
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

    printModuleList(modules);
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

    printModuleDetails(module, modules);
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
    printModuleDetails(module, modules);
  });

moduleCommand
  .command("delete")
  .description("Delete a module.")
  .argument("<displayName>", "module display name")
  .action(async (displayName: string) => {
    await requireRegistration();
    const modules = await readModules();
    const index = modules.findIndex((module) => {
      const reference = getModuleReference(modules, module);
      return module.displayName === displayName || module.id === displayName || reference === displayName;
    });

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
