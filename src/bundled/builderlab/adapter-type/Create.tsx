import {
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { AgentInstructions } from "../../../features/agents/AgentInstructions";
import { ModelFamilyMenu } from "../../../features/agents/ModelFamilyMenu";
import type { AgentCreateProps } from "../../../features/agents/service";
import { Button } from "../../../shared/design-system/ui/Button";
import { Select } from "../../../shared/design-system/ui/Select";
import { SettingsGroup } from "../../../shared/design-system/ui/SettingsGroup";
import {
  type AgentClient,
  type RemoteAgentModel,
  validInstructions,
} from "../agents/client";
import type { BuilderlabSession } from "../session";
import { effortLabel, modelChoice } from "./models";

export type CreationConfig = {
  instructions: string;
  modelId: string;
  reasoningEffort: string;
  subject?: string;
};
export const EMPTY_CREATION: CreationConfig = {
  instructions: "",
  modelId: "",
  reasoningEffort: "",
};

export function creationConfig(value: unknown): CreationConfig {
  const config = value as Partial<CreationConfig> | undefined;
  if (
    !config ||
    !validInstructions(config.instructions) ||
    typeof config.modelId !== "string" ||
    !config.modelId.trim() ||
    typeof config.reasoningEffort !== "string" ||
    !config.reasoningEffort.trim() ||
    typeof config.subject !== "string"
  )
    throw new Error(
      "Choose a model and thinking level and check the instructions.",
    );
  return config as CreationConfig;
}

export function createCreationFields(
  client: AgentClient,
  session: BuilderlabSession,
) {
  function CreateConfiguration({
    config,
    onChange,
    disabled,
    harnessControl,
  }: AgentCreateProps & { harnessControl: ReactNode }) {
    const draft = config as CreationConfig;
    const login = useSyncExternalStore(session.subscribe, session.snapshot);
    const [models, setModels] = useState<readonly RemoteAgentModel[]>();
    const [error, setError] = useState("");
    const [revision, setRevision] = useState(0);
    // biome-ignore lint/correctness/useExhaustiveDependencies: revision retries catalog loading without changing the draft.
    useEffect(() => {
      if (login.status !== "signed-in") return;
      const controller = new AbortController();
      setModels(undefined);
      setError("");
      void client.modelCatalog(controller.signal).then(
        (catalog) => {
          if (!controller.signal.aborted) setModels(catalog);
        },
        (reason) => {
          if (!controller.signal.aborted)
            setError(
              reason instanceof Error
                ? reason.message
                : "Could not load models.",
            );
        },
      );
      return () => controller.abort();
    }, [client, login, revision]);
    const model = models?.find((choice) => choice.id === draft.modelId);
    const supported = !!model?.supportedReasoningEfforts.includes(
      draft.reasoningEffort,
    );
    const wrongAccount =
      draft.subject && draft.subject !== login.account?.subject;
    return (
      <div className="grid gap-4">
        <SettingsGroup>
          {harnessControl}
          {login.status === "signed-in" && !!models?.length && (
            <>
              <ModelFamilyMenu
                label="Model"
                align="end"
                selected={
                  model
                    ? modelChoice(model)
                    : { id: "", label: "Choose a model" }
                }
                models={models.map(modelChoice)}
                disabled={disabled}
                onChange={(modelId) =>
                  onChange({
                    ...draft,
                    modelId,
                    reasoningEffort: "",
                    subject: login.account?.subject,
                  })
                }
              />
              <Select
                label="Thinking"
                variant="preference"
                align="end"
                name="builderlab-effort"
                required
                value={supported ? draft.reasoningEffort : ""}
                placeholder="Choose thinking"
                disabled={disabled || !model || !!wrongAccount}
                groups={[
                  {
                    label: "",
                    options: (model?.supportedReasoningEfforts ?? []).map(
                      (value) => ({ value, label: effortLabel(value) }),
                    ),
                  },
                ]}
                onValueChange={(reasoningEffort) =>
                  onChange({ ...draft, reasoningEffort })
                }
              />
            </>
          )}
        </SettingsGroup>
        {login.status !== "signed-in" ? (
          <div className="grid justify-items-start gap-3">
            <p role="status" className="m-0 text-body-sm text-secondary">
              {login.checking
                ? "Checking your Builderlab sign-in…"
                : login.status === "pending"
                  ? "Finish sign-in in your browser, then choose a model."
                  : "Sign in to choose a model and thinking level."}
            </p>
            {login.error && (
              <p role="alert" className="m-0 text-body-sm text-danger">
                {login.error}
              </p>
            )}
            <Button
              disabled={disabled && login.status !== "pending"}
              loading={login.checking === true}
              onClick={() => {
                if (login.status === "pending") session.cancel();
                else void session.signIn();
              }}
            >
              {login.checking
                ? "Checking sign-in"
                : login.status === "pending"
                  ? "Cancel sign-in"
                  : "Sign in with Builderlab"}
            </Button>
          </div>
        ) : models?.length ? (
          wrongAccount && (
            <p role="status" className="m-0 text-body-sm text-secondary">
              These choices belong to another Builderlab account. Choose a model
              and thinking level again.
            </p>
          )
        ) : (
          <p
            role={error ? "alert" : "status"}
            className={`m-0 text-body-sm ${error ? "text-danger" : "text-secondary"}`}
          >
            {models
              ? "No models are available. Retry when the catalog is available."
              : error || "Loading models…"}
          </p>
        )}
        {login.status === "signed-in" && (error || models?.length === 0) && (
          <div>
            <Button
              disabled={disabled}
              onClick={() => setRevision((value) => value + 1)}
            >
              Retry models
            </Button>
          </div>
        )}
      </div>
    );
  }

  function Create({ config, onChange, disabled }: AgentCreateProps) {
    const draft = config as CreationConfig;
    return (
      <AgentInstructions
        creation
        value={draft.instructions}
        disabled={disabled}
        onChange={(instructions) => onChange({ ...draft, instructions })}
      />
    );
  }

  return { Create, CreateConfiguration };
}
