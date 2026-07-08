import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Command } from "commander";

type ModuleRecord = {
  id: string;
  blueprintId: string;
  displayName: string;
  connectedTo: string[];
  runtimeAttributes: Record<string, unknown>;
  capabilities: string[];
};

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
  .description("Register this Habitat CLI with Kepler and manage its registration.")
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

const moduleCommand = program.command("module").description("Manage local habitat modules.");

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
