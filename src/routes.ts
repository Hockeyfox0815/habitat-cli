import { Hono } from "hono";
import type { Context } from "hono";
import type { InventoryStore } from "./construction";
import {
  readInventory,
  readModules,
  readRegistration,
  removeInventory,
  removeModules,
  removeRegistration,
  writeInventory,
  writeModules,
  writeRegistration,
  type RegistrationRecord,
} from "./local-state";
import type { ModuleRecord } from "./power";

const DEFAULT_KEPLER_BASE_URL = "https://planet.turingguild.com";

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
  apiToken?: string;
};

type HabitatResponse = {
  habitat: Habitat;
};

type BlueprintCatalogResponse = {
  blueprints: unknown[];
};

type BlueprintResponse = {
  blueprint: unknown;
};

type ResourceCatalogResponse = {
  resources: unknown[];
};

class KeplerHttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function getKeplerBaseUrl() {
  const value =
    Bun.env.KEPLER_BASE_URL ??
    Bun.env.KEPLER_WORLD_BASE_URL ??
    Bun.env.PLANET_SERVER_PUBLIC_BASE_URL ??
    DEFAULT_KEPLER_BASE_URL;

  return value.replace(/\/+$/, "");
}

function getKeplerToken() {
  return Bun.env.KEPLER_PLANET_TOKEN ?? Bun.env.KEPLER_WORLD_TOKEN ?? Bun.env.PLANET_TOKEN;
}

function logHabitatApi(method: string, path: string, summary: string) {
  console.log(`[habitat-api] ${method} ${path} -> ${summary}`);
}

function logKepler(method: string, path: string, status: number) {
  console.log(`[kepler] ${method} ${path} -> ${status}`);
}

async function keplerRequest<T>(path: string, options: RequestInit = {}) {
  const token = getKeplerToken();
  if (!token) {
    throw new Error("Missing Kepler token. Set KEPLER_PLANET_TOKEN in the backend environment.");
  }

  let response: Response;

  try {
    response = await fetch(`${getKeplerBaseUrl()}${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        ...options.headers,
      },
    });
  } catch (error) {
    const details = error instanceof Error ? ` ${error.message}` : "";
    throw new Error(`Unable to reach Kepler at ${getKeplerBaseUrl()}.${details}`);
  }

  logKepler(options.method ?? "GET", path, response.status);

  const text = await response.text();
  if (!response.ok) {
    const details = text ? ` ${text}` : "";
    throw new KeplerHttpError(response.status, `Kepler request failed with ${response.status}.${details}`);
  }

  return text ? (JSON.parse(text) as T) : ({} as T);
}

async function proxyKepler<T>(c: Context, path: string, options: RequestInit = {}) {
  try {
    const response = await keplerRequest<T>(path, options);
    return c.json(response);
  } catch (error) {
    if (error instanceof KeplerHttpError) {
      return c.json({ error: error.message }, error.status as never);
    }

    throw error;
  }
}

function toRegistrationResponse(registration: RegistrationRecord | null) {
  return { registration };
}

export function createHabitatApp() {
  const app = new Hono();

  app.get("/registration", async (c) => {
    const registration = await readRegistration();
    logHabitatApi("GET", "/registration", registration ? "registered" : "not registered");
    return c.json(toRegistrationResponse(registration));
  });

  app.put("/registration", async (c) => {
    const payload = (await c.req.json()) as { registration: RegistrationRecord };
    await writeRegistration(payload.registration);
    logHabitatApi("PUT", "/registration", "saved registration");
    return c.json(toRegistrationResponse(payload.registration));
  });

  app.delete("/registration", async (c) => {
    await removeRegistration();
    logHabitatApi("DELETE", "/registration", "cleared registration");
    return c.json(toRegistrationResponse(null));
  });

  app.get("/modules", async (c) => {
    const modules = await readModules();
    logHabitatApi("GET", "/modules", `${modules.length} modules`);
    return c.json({ modules });
  });

  app.put("/modules", async (c) => {
    const payload = (await c.req.json()) as { modules: ModuleRecord[] };
    await writeModules(payload.modules ?? []);
    logHabitatApi("PUT", "/modules", `${(payload.modules ?? []).length} modules saved`);
    return c.json({ modules: payload.modules ?? [] });
  });

  app.delete("/modules", async (c) => {
    await removeModules();
    logHabitatApi("DELETE", "/modules", "cleared modules");
    return c.json({ modules: [] });
  });

  app.get("/inventory", async (c) => {
    const inventory = await readInventory();
    logHabitatApi("GET", "/inventory", `${Object.keys(inventory.resources).length} resources`);
    return c.json({ inventory });
  });

  app.put("/inventory", async (c) => {
    const payload = (await c.req.json()) as { inventory: InventoryStore };
    await writeInventory(payload.inventory ?? { resources: {} });
    logHabitatApi("PUT", "/inventory", "saved inventory");
    return c.json({ inventory: payload.inventory ?? { resources: {} } });
  });

  app.delete("/inventory", async (c) => {
    await removeInventory();
    logHabitatApi("DELETE", "/inventory", "cleared inventory");
    return c.json({ inventory: { resources: {} } });
  });

  app.post("/habitats/register", async (c) => {
    const payload = (await c.req.json()) as { habitatUuid: string; displayName: string };
    try {
      const response = await keplerRequest<HabitatRegistrationResponse>("/habitats/register", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      logHabitatApi("POST", "/habitats/register", "proxied to Kepler");
      return c.json(
        {
          ...response,
          apiToken: getKeplerToken(),
        },
        201,
      );
    } catch (error) {
      if (error instanceof KeplerHttpError) {
        return c.json({ error: error.message }, error.status as never);
      }

      throw error;
    }
  });

  app.get("/habitats/:habitatId", async (c) => {
    const habitatId = c.req.param("habitatId");
    logHabitatApi("GET", `/habitats/${habitatId}`, "proxied to Kepler");
    return proxyKepler<HabitatResponse>(c, `/habitats/${habitatId}`, {});
  });

  app.delete("/habitats/:habitatId", async (c) => {
    const habitatId = c.req.param("habitatId");
    logHabitatApi("DELETE", `/habitats/${habitatId}`, "proxied to Kepler");
    try {
      await keplerRequest(`/habitats/${habitatId}`, { method: "DELETE" });
      return c.body(null, 204);
    } catch (error) {
      if (error instanceof KeplerHttpError) {
        return c.json({ error: error.message }, error.status as never);
      }

      throw error;
    }
  });

  app.get("/catalog/blueprints", async (c) => {
    logHabitatApi("GET", "/catalog/blueprints", "proxied to Kepler");
    return proxyKepler<BlueprintCatalogResponse>(c, "/catalog/blueprints");
  });

  app.get("/catalog/blueprints/:blueprintId", async (c) => {
    const blueprintId = c.req.param("blueprintId");
    logHabitatApi("GET", `/catalog/blueprints/${blueprintId}`, "proxied to Kepler");
    return proxyKepler<BlueprintResponse>(c, `/catalog/blueprints/${encodeURIComponent(blueprintId)}`);
  });

  app.get("/catalog/resources", async (c) => {
    logHabitatApi("GET", "/catalog/resources", "proxied to Kepler");
    return proxyKepler<ResourceCatalogResponse>(c, "/catalog/resources");
  });

  app.get("/world/solar-irradiance", async (c) => {
    logHabitatApi("GET", "/world/solar-irradiance", "proxied to Kepler");
    return proxyKepler<{ solarIrradiance: unknown }>(c, "/world/solar-irradiance");
  });

  return app;
}
