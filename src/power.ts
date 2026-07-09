export type ModuleRecord = {
  id: string;
  blueprintId: string;
  displayName: string;
  connectedTo: string[];
  runtimeAttributes: Record<string, unknown>;
  capabilities: string[];
};

type ModuleWithPower = ModuleRecord & {
  runtimeAttributes: {
    status?: string;
    currentEnergyKwh?: number;
    powerDrawKw?: Record<string, number | undefined>;
  } & Record<string, unknown>;
};

type PowerTickResult = {
  modules: ModuleRecord[];
  batteryEnergyKwh: number;
  poweredModuleNames: string[];
  poweredModuleIds: string[];
  offlineModuleNames: string[];
};

const CRITICAL_MODULES = new Set(["Command Module", "Life Support"]);

function toNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function getModuleStatus(module: ModuleWithPower) {
  return typeof module.runtimeAttributes.status === "string" ? module.runtimeAttributes.status : "offline";
}

export function getModulePowerState(module: ModuleRecord) {
  return typeof (module as ModuleWithPower).runtimeAttributes.status === "string"
    ? ((module as ModuleWithPower).runtimeAttributes.status as string)
    : "offline";
}

export function getModuleCurrentPowerDrawKw(module: ModuleRecord) {
  const moduleWithPower = module as ModuleWithPower;
  const drawByStatus = moduleWithPower.runtimeAttributes.powerDrawKw;
  const status = getModulePowerState(module);

  if (!drawByStatus) {
    return 0;
  }

  return toNumber(drawByStatus[status]);
}

export function getEnergyCostPerTickKwh(drawKw: number) {
  return drawKw / 3600;
}

function getPowerDrawKw(module: ModuleWithPower) {
  const drawByStatus = module.runtimeAttributes.powerDrawKw;
  const status = getModuleStatus(module);

  if (!drawByStatus) {
    return 0;
  }

  return toNumber(drawByStatus[status]);
}

function isBatteryModule(module: ModuleRecord) {
  return module.blueprintId === "basic-battery" || module.capabilities.includes("power-storage");
}

function comparePriority(left: { module: ModuleRecord; index: number }, right: { module: ModuleRecord; index: number }) {
  const leftCritical = CRITICAL_MODULES.has(left.module.displayName);
  const rightCritical = CRITICAL_MODULES.has(right.module.displayName);

  if (leftCritical !== rightCritical) {
    return leftCritical ? -1 : 1;
  }

  return left.index - right.index;
}

function createOrderedPowerCandidates(modules: ModuleRecord[]) {
  return modules
    .map((module, index) => ({ module, index }))
    .filter(({ module }) => !isBatteryModule(module))
    .sort(comparePriority);
}

export function simulatePowerTicks(modules: ModuleRecord[], tickCount: number): PowerTickResult {
  const nextModules = structuredClone(modules) as ModuleRecord[];
  const batteryModule = nextModules.find(isBatteryModule) as ModuleWithPower | undefined;
  const candidates = createOrderedPowerCandidates(nextModules) as Array<{ module: ModuleWithPower; index: number }>;
  const poweredModuleNames: string[] = [];
  const poweredModuleIds: string[] = [];
  const offlineModuleNames: string[] = [];

  if (!batteryModule) {
    return {
      modules: nextModules,
      batteryEnergyKwh: 0,
      poweredModuleNames,
      poweredModuleIds,
      offlineModuleNames,
    };
  }

  const startingEnergyKwh = toNumber(batteryModule.runtimeAttributes.currentEnergyKwh);
  let remainingEnergyKwh = startingEnergyKwh;
  let powerShortfall = false;

  for (const { module } of candidates) {
    const drawKw = getPowerDrawKw(module);
    const requiredEnergyKwh = getEnergyCostPerTickKwh(drawKw);

    if (powerShortfall && requiredEnergyKwh > 0) {
      module.runtimeAttributes.status = "offline";
      offlineModuleNames.push(module.displayName);
      continue;
    }

    if (requiredEnergyKwh === 0) {
      poweredModuleNames.push(module.displayName);
      poweredModuleIds.push(module.id);
      continue;
    }

    if (remainingEnergyKwh >= requiredEnergyKwh) {
      remainingEnergyKwh -= requiredEnergyKwh;
      poweredModuleNames.push(module.displayName);
      poweredModuleIds.push(module.id);
      continue;
    }

    module.runtimeAttributes.status = "offline";
    offlineModuleNames.push(module.displayName);
    powerShortfall = true;
  }

  batteryModule.runtimeAttributes.currentEnergyKwh = powerShortfall ? 0 : remainingEnergyKwh;

  return {
    modules: nextModules,
    batteryEnergyKwh: batteryModule.runtimeAttributes.currentEnergyKwh ?? 0,
    poweredModuleNames,
    poweredModuleIds,
    offlineModuleNames,
  };
}
