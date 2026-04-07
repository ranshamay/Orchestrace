import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { fetchModels } from '../../lib/api';

export type MissingModelWarning = {
  provider: string;
  missingModel: string;
  suggestedModel: string;
  message: string;
};

export function useProviderModels(
  workProvider: string,
  workModel: string,
  setWorkModel: Dispatch<SetStateAction<string>>,
  preferredModelForProvider?: string,
) {
  const [providerModels, setProviderModels] = useState<Record<string, string[]>>({});
  const [missingModelWarning, setMissingModelWarning] = useState<MissingModelWarning | null>(null);

  const lastKnownModelByProviderRef = useRef<Record<string, string>>({});
  const warnedMissingKeyRef = useRef<string>('');

  const resolveDefaultModel = useCallback((models: string[], preferredModel?: string): string => {
    if (models.length === 0) {
      return '';
    }

    if (preferredModel && models.includes(preferredModel)) {
      return preferredModel;
    }

    return models[0];
  }, []);

  const clearMissingModelWarning = useCallback(() => {
    warnedMissingKeyRef.current = '';
    setMissingModelWarning(null);
  }, []);

  const confirmMissingModelSwitch = useCallback(() => {
    setMissingModelWarning((warning) => {
      if (!warning) {
        return warning;
      }
      setWorkModel(warning.suggestedModel);
      warnedMissingKeyRef.current = '';
      return null;
    });
  }, [setWorkModel]);

  useEffect(() => {
    if (!workProvider) {
      return;
    }

    if (workModel.length > 0) {
      lastKnownModelByProviderRef.current[workProvider] = workModel;
    }
  }, [workModel, workProvider]);

  useEffect(() => {
    if (!workProvider) {
      return;
    }

    let cancelled = false;

    const loadModels = async () => {
      try {
        const response = await fetchModels(workProvider);
        if (cancelled) {
          return;
        }

        setProviderModels((previous) => ({
          ...previous,
          [workProvider]: response.models,
        }));

        if (response.models.length === 0) {
          return;
        }

        setWorkModel((current) => {
          if (current.length > 0) {
            return current;
          }

          const rememberedModel = lastKnownModelByProviderRef.current[workProvider];
          if (rememberedModel && response.models.includes(rememberedModel)) {
            clearMissingModelWarning();
            return rememberedModel;
          }

          const nextModel = resolveDefaultModel(response.models, preferredModelForProvider);
          if (nextModel) {
            clearMissingModelWarning();
          }
          return nextModel;
        });
      } catch {
        if (cancelled) {
          return;
        }

        setProviderModels((previous) => ({
          ...previous,
          [workProvider]: [],
        }));
      }
    };

    void loadModels();

    return () => {
      cancelled = true;
    };
  }, [clearMissingModelWarning, preferredModelForProvider, resolveDefaultModel, setWorkModel, workProvider]);

  useEffect(() => {
    if (!workProvider) {
      return;
    }

    const models = providerModels[workProvider] ?? [];
    if (models.length === 0) {
      return;
    }

    if (workModel.length === 0) {
      const rememberedModel = lastKnownModelByProviderRef.current[workProvider];
      if (rememberedModel && models.includes(rememberedModel)) {
        setWorkModel(rememberedModel);
        clearMissingModelWarning();
        return;
      }

      const nextModel = resolveDefaultModel(models, preferredModelForProvider);
      if (nextModel.length > 0) {
        setWorkModel(nextModel);
        clearMissingModelWarning();
      }
      return;
    }

    if (models.includes(workModel)) {
      clearMissingModelWarning();
      warnedMissingKeyRef.current = '';
      return;
    }

    const rememberedModel = lastKnownModelByProviderRef.current[workProvider];
    if (rememberedModel && rememberedModel !== workModel && models.includes(rememberedModel)) {
      setWorkModel(rememberedModel);
      clearMissingModelWarning();
      return;
    }

    const suggestedModel = resolveDefaultModel(models, preferredModelForProvider);
    if (!suggestedModel) {
      return;
    }

    const missingKey = `${workProvider}::${workModel}`;
    if (warnedMissingKeyRef.current === missingKey) {
      return;
    }

    warnedMissingKeyRef.current = missingKey;
    setMissingModelWarning({
      provider: workProvider,
      missingModel: workModel,
      suggestedModel,
      message: `Model "${workModel}" is no longer available for ${workProvider}. Switch to "${suggestedModel}"?`,
    });
  }, [
    clearMissingModelWarning,
    preferredModelForProvider,
    providerModels,
    resolveDefaultModel,
    setWorkModel,
    workModel,
    workProvider,
  ]);

  return {
    providerModels,
    currentModels: providerModels[workProvider] ?? [],
    missingModelWarning,
    confirmMissingModelSwitch,
    dismissMissingModelWarning: clearMissingModelWarning,
  };
}