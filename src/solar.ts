import type { ModuleRecord } from "./power";

export type SolarIrradiance = {
  wPerM2?: number;
  condition?: string;
};

export type SolarIrradianceResponse = {
  solarIrradiance?: SolarIrradiance;
};

export type SolarChargeResult = {
  modules: ModuleRecord[];
  generatedKwh: number;
  reason?: string;
  solarCondition?: string;
  irradianceWPerM2?: number;
};

type ModuleWithRuntime = ModuleRecord & {
  runtimeAttributes: Record<string, unknown> & {
    status?: string;
    currentEnergyKwh?: number;
    energyStorageKwh?: number;
    powerGenerationKw?: number;
  };
};

const SOLAR_EFFICIENCY = 0.5;

function toNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function getStatus(module: ModuleRecord) {
  const status = (module.runtimeAttributes as Record<string, unknown>).status;
  return typeof status === "string" ? status : "offline";
}

function isEffectiveOnline(module: ModuleRecord) {
  const status = getStatus(module);
  return status === "online" || status === "active";
}

function isSolarModule(module: ModuleRecord) {
  return (
    module.capabilities.includes("solar-generation") ||
    module.blueprintId.includes("solar")
  );
}

function isBatteryModule(module: ModuleRecord) {
  return module.blueprintId === "basic-battery" || module.capabilities.includes("power-storage");
}

function getPowerGenerationKw(module: ModuleRecord) {
  return toNumber((module.runtimeAttributes as Record<string, unknown>).powerGenerationKw);
}

export function formatSolarStatus(irradiance: SolarIrradiance) {
  const watts = toNumber(irradiance.wPerM2);
  const condition = irradiance.condition ?? "unknown";
  return `Solar irradiance: ${watts} W/m2 (${condition}).`;
}

export function applySolarCharging(modules: ModuleRecord[], irradiance?: SolarIrradiance | null): SolarChargeResult {
  const nextModules = structuredClone(modules) as ModuleRecord[];

  if (!irradiance || typeof irradiance.wPerM2 !== "number") {
    return {
      modules: nextModules,
      generatedKwh: 0,
      reason: "Kepler did not provide a usable solar irradiance reading.",
    };
  }

  const solarModules = nextModules.filter((module) => isSolarModule(module) && isEffectiveOnline(module));
  if (solarModules.length === 0) {
    return {
      modules: nextModules,
      generatedKwh: 0,
      irradianceWPerM2: irradiance.wPerM2,
      solarCondition: irradiance.condition,
      reason: "No online solar modules could generate power.",
    };
  }

  const batteries = nextModules.filter((module) => isBatteryModule(module) && isEffectiveOnline(module));
  if (batteries.length === 0) {
    return {
      modules: nextModules,
      generatedKwh: 0,
      irradianceWPerM2: irradiance.wPerM2,
      solarCondition: irradiance.condition,
      reason: "No online battery modules could receive charge.",
    };
  }

  if (irradiance.wPerM2 <= 0) {
    return {
      modules: nextModules,
      generatedKwh: 0,
      irradianceWPerM2: irradiance.wPerM2,
      solarCondition: irradiance.condition,
      reason: "Solar irradiance is zero, so no charging happened.",
    };
  }

  const solarMultiplier = irradiance.wPerM2 / 900;
  const totalGenerationKw = solarModules.reduce((sum, module) => sum + getPowerGenerationKw(module), 0);
  let generatedKwh = (totalGenerationKw * solarMultiplier * SOLAR_EFFICIENCY) / 3600;

  if (generatedKwh <= 0) {
    return {
      modules: nextModules,
      generatedKwh: 0,
      irradianceWPerM2: irradiance.wPerM2,
      solarCondition: irradiance.condition,
      reason: "Online solar modules do not have usable generation attributes.",
    };
  }

  let storedKwh = 0;

  for (const module of batteries) {
    const runtimeAttributes = (module as ModuleWithRuntime).runtimeAttributes;
    const currentEnergyKwh = toNumber(runtimeAttributes.currentEnergyKwh);
    const energyStorageKwh = toNumber(runtimeAttributes.energyStorageKwh);
    const remainingCapacity = Math.max(0, energyStorageKwh - currentEnergyKwh);

    if (remainingCapacity <= 0) {
      continue;
    }

    const chargeAmount = Math.min(remainingCapacity, generatedKwh);
    runtimeAttributes.currentEnergyKwh = currentEnergyKwh + chargeAmount;
    storedKwh += chargeAmount;
    generatedKwh -= chargeAmount;

    if (generatedKwh <= 0) {
      break;
    }
  }

  if (storedKwh <= 0) {
    return {
      modules: nextModules,
      generatedKwh: 0,
      irradianceWPerM2: irradiance.wPerM2,
      solarCondition: irradiance.condition,
      reason: "Battery storage is already full.",
    };
  }

  return {
    modules: nextModules,
    generatedKwh: storedKwh,
    irradianceWPerM2: irradiance.wPerM2,
    solarCondition: irradiance.condition,
  };
}
