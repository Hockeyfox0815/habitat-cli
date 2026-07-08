import { readFile, mkdtemp, rm } from "node:fs/promises";
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
    runtimeAttributes: { status: "active" },
    capabilities: ["habitat-command"],
  },
  {
    id: "module-life-support",
    blueprintId: "life-support",
    displayName: "Life Support",
    connectedTo: [],
    runtimeAttributes: { status: "active" },
    capabilities: ["atmosphere-control", "redundant-life-support"],
  },
  {
    id: "module-basic-battery",
    blueprintId: "basic-battery",
    displayName: "Basic Battery",
    connectedTo: [],
    runtimeAttributes: { status: "offline" },
    capabilities: ["power-storage"],
  },
  {
    id: "module-supply-cache",
    blueprintId: "supply-cache",
    displayName: "Supply Cache",
    connectedTo: [],
    runtimeAttributes: { status: "active" },
    capabilities: ["storage"],
  },
  {
    id: "module-workshop-fabricator",
    blueprintId: "workshop-fabricator",
    displayName: "Workshop Fabricator",
    connectedTo: [],
    runtimeAttributes: { status: "idle" },
    capabilities: ["basic-fabrication"],
  },
  {
    id: "module-basic-suitport",
    blueprintId: "basic-suitport",
    displayName: "Basic Suitport",
    connectedTo: [],
    runtimeAttributes: { status: "idle" },
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
