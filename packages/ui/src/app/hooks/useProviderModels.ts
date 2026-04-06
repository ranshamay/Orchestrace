import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { fetchModels } from '../../lib/api';

type MissingModelWarning = {
  provider: string;
  missingModel: string;
  fallbackModel: string;
};

export function useProviderModels(
  workProvider: string,
  workModel: string,
  setWorkModel: Dispatch<SetStateAction<string>>,
) {
  const [providerModels, setProviderModels] = useState<Record<string, string[]>>({});
  const [dismissedMissingKey, setDismissedMissingKey] = useState('');

  const missingModelByProviderRef = useRef<Record<string, string>>({});
  const confirmedFallbackByProviderRef = useRef<Record<string, string>>({});

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

        if (response.models.length > 0 && workModel.length === 0) {
          setWorkModel(response.models[0]);
        }
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
  }, [setWorkModel, workModel.length, workProvider]);

  const currentModels = useMemo(() => providerModels[workProvider] ?? [], [providerModels, workProvider]);

  useEffect(() => {
    if (!workProvider || workModel.length === 0) {
      return;
    }

    if (currentModels.includes(workModel)) {
      const missingModel = missingModelByProviderRef.current[workProvider];
      const confirmedFallback = confirmedFallbackByProviderRef.current[workProvider];

      if (missingModel && confirmedFallback && workModel === confirmedFallback && currentModels.includes(missingModel)) {
        setWorkModel(missingModel);
        delete missingModelByProviderRef.current[workProvider];
        delete confirmedFallbackByProviderRef.current[workProvider];
      } else if (confirmedFallback && workModel !== confirmedFallback) {
        delete missingModelByProviderRef.current[workProvider];
        delete confirmedFallbackByProviderRef.current[workProvider];
      }

      return;
    }

    missingModelByProviderRef.current[workProvider] = workModel;
  }, [currentModels, setWorkModel, workModel, workProvider]);

  const warningCandidate = useMemo<MissingModelWarning | null>(() => {
    if (!workProvider || workModel.length === 0) {
      return null;
    }

    if (currentModels.length === 0 || currentModels.includes(workModel)) {
      return null;
    }

    const fallbackModel = currentModels[0] ?? '';
    return {
      provider: workProvider,
      missingModel: workModel,
      fallbackModel,
    };
  }, [currentModels, workModel, workProvider]);

  const warningKey = useMemo(() => {
    if (!warningCandidate) {
      return '';
    }

    return `${warningCandidate.provider}:${warningCandidate.missingModel}:${warningCandidate.fallbackModel}`;
  }, [warningCandidate]);

  const missingModelWarning = useMemo(() => {
    if (!warningCandidate || warningKey === dismissedMissingKey) {
      return null;
    }

    return warningCandidate;
  }, [dismissedMissingKey, warningCandidate, warningKey]);

  const confirmMissingModelSwitch = useCallback(() => {
    if (!missingModelWarning || !missingModelWarning.fallbackModel) {
      return;
    }

    confirmedFallbackByProviderRef.current[missingModelWarning.provider] = missingModelWarning.fallbackModel;
    setDismissedMissingKey('');
    setWorkModel(missingModelWarning.fallbackModel);
  }, [missingModelWarning, setWorkModel]);

  const dismissMissingModelWarning = useCallback(() => {
    if (!warningKey) {
      return;
    }

    setDismissedMissingKey(warningKey);
  }, [warningKey]);

  return {
    providerModels,
    currentModels,
    missingModelWarning,
    confirmMissingModelSwitch,
    dismissMissingModelWarning,
  };
}