import {
  ActionGroup,
  Alert,
  Button,
  Card,
  CardBody,
  FileUpload,
  Form,
  FormGroup,
  FormHelperText,
  FormSelect,
  FormSelectOption,
  HelperText,
  HelperTextItem,
  InputGroup,
  InputGroupItem,
  PageSection,
  Skeleton,
  TextArea,
  TextInput,
  Title,
  ToggleGroup,
  ToggleGroupItem,
  Content,
} from '@patternfly/react-core';
import SyncAltIcon from '@patternfly/react-icons/dist/esm/icons/sync-alt-icon';
import { useEffect, useState, type FormEvent } from 'react';
import { api, SCAN_ID_PATTERN, THINKING_LEVELS, type Model, type ModelOptions, type Profile, type SkillPack, type ThinkingLevel } from '../api';
import { emptyGitSource, GitSourceFields, type GitSourceValue } from '../components/GitSourceFields';
import { TagSelect } from '../components/TagSelect';
import { navigate, scanRoute } from '../router';

/** Random, so callers never pick the same id by chance. */
const newScanId = (): string => crypto.randomUUID();

export function NewScanPage() {
  const [profiles, setProfiles] = useState<Profile[]>();
  const [models, setModels] = useState<Model[]>();
  const [loadError, setLoadError] = useState<string>();

  const [id, setId] = useState(newScanId);
  const [profile, setProfile] = useState('');
  const [model, setModel] = useState('');
  // '': the model's own behaviour, and nothing is sent.
  const [thinking, setThinking] = useState<'' | 'on' | 'off'>('');
  const [thinkingLevel, setThinkingLevel] = useState<'' | ThinkingLevel>('');
  const [language, setLanguage] = useState('');
  const [instructions, setInstructions] = useState('');
  const [timeout, setTimeoutMinutes] = useState('');
  const [file, setFile] = useState<File>();
  const [sourceKind, setSourceKind] = useState<'zip' | 'git'>('zip');
  const [git, setGit] = useState<GitSourceValue>(emptyGitSource);
  const [packs, setPacks] = useState<SkillPack[]>([]);
  const [chosenPacks, setChosenPacks] = useState<string[]>([]);

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string>();

  useEffect(() => {
    Promise.all([api.profiles(), api.models()])
      .then(([p, m]) => {
        setProfiles(p);
        setModels(m);
        setProfile(p[0]?.name ?? '');
        setModel(m.find((x) => x.default)?.id ?? m[0]?.id ?? '');
      })
      .catch((e: Error) => setLoadError(e.message));
    // Optional: without Skill Packs the form works as before.
    api.skillPacks().then(setPacks).catch(() => undefined);
  }, []);

  const idValid = SCAN_ID_PATTERN.test(id);
  const hasSource = sourceKind === 'zip' ? Boolean(file) : Boolean(git.url.trim());
  // Empty: the server setting. Otherwise whole minutes, as the server accepts them.
  const timeoutValid = timeout.trim() === '' || (/^\d+$/.test(timeout.trim()) && +timeout >= 1 && +timeout <= 1440);
  const canSubmit = idValid && Boolean(profile) && hasSource && timeoutValid && !submitting;
  const selectedProfile = profiles?.find((p) => p.name === profile);
  // Offered only for models whose provider takes it; a choice made for another model is not sent.
  const takesThinking = Boolean(models?.find((m) => m.id === model)?.options?.includes('thinking'));
  const modelOptions: ModelOptions | undefined =
    takesThinking && thinking
      ? { thinking, ...(thinking === 'on' && thinkingLevel && { thinkingLevel }) }
      : undefined;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setSubmitError(undefined);
    try {
      const scan = await api.createScan({
        id,
        ...(sourceKind === 'zip'
          ? { file }
          : {
              repo: {
                url: git.url.trim(),
                ref: git.ref.trim() || undefined,
                credentials: { username: git.username.trim() || undefined, token: git.token || undefined },
              },
            }),
        profile,
        model,
        modelOptions,
        language: language.trim(),
        instructions: instructions.trim(),
        skillPacks: chosenPacks,
        attemptTimeoutMinutes: timeout.trim() ? Number(timeout) : undefined,
      });
      navigate(scanRoute(scan.id, 'logs'));
    } catch (e) {
      setSubmitError((e as Error).message);
      setSubmitting(false);
    }
  }

  return (
    <>
      <PageSection>
        <Content>
          <Title headingLevel="h1">New Scan</Title>
          <p>Upload a zip of source code and choose the analysis to run on it.</p>
        </Content>
      </PageSection>
      <PageSection isFilled>
        <Card>
          <CardBody>
            {loadError && (
              <Alert variant="danger" isInline title="Could not load Scan Profiles and models" className="pf-v6-u-mb-md">
                {loadError}
              </Alert>
            )}
            {!profiles || !models ? (
              !loadError && <Skeleton height="300px" screenreaderText="Loading" />
            ) : (
              <Form onSubmit={submit} isWidthLimited>
                <FormGroup label="Source" fieldId="source-kind" role="radiogroup">
                  <ToggleGroup aria-label="Source">
                    <ToggleGroupItem
                      text="Zip archive"
                      buttonId="source-zip"
                      isSelected={sourceKind === 'zip'}
                      onChange={() => setSourceKind('zip')}
                      isDisabled={submitting}
                    />
                    <ToggleGroupItem
                      text="Git repository"
                      buttonId="source-git"
                      isSelected={sourceKind === 'git'}
                      onChange={() => setSourceKind('git')}
                      isDisabled={submitting}
                    />
                  </ToggleGroup>
                </FormGroup>

                {sourceKind === 'git' ? (
                  <GitSourceFields value={git} onChange={setGit} isDisabled={submitting} />
                ) : (
                <FormGroup label="Source Archive" isRequired fieldId="archive">
                  <FileUpload
                    id="archive"
                    value={file}
                    filename={file?.name ?? ''}
                    filenamePlaceholder="Drag a .zip here or browse"
                    browseButtonText="Browse…"
                    hideDefaultPreview
                    dropzoneProps={{ accept: { 'application/zip': ['.zip'] } }}
                    onFileInputChange={(_e, f) => setFile(f)}
                    onClearClick={() => setFile(undefined)}
                    isDisabled={submitting}
                  />
                  <FormHelperText>
                    <HelperText>
                      <HelperTextItem>
                        {file ? `${(file.size / 1024 / 1024).toFixed(2)} MB` : 'A zip file of the code to analyse.'}
                      </HelperTextItem>
                    </HelperText>
                  </FormHelperText>
                </FormGroup>
                )}

                <FormGroup label="Scan Profile" isRequired fieldId="profile">
                  <FormSelect id="profile" value={profile} onChange={(_e, v) => setProfile(v)} isDisabled={submitting}>
                    {profiles.map((p) => (
                      <FormSelectOption key={p.name} value={p.name} label={p.name} />
                    ))}
                  </FormSelect>
                  {selectedProfile && (
                    <FormHelperText>
                      <HelperText>
                        <HelperTextItem>{selectedProfile.description}</HelperTextItem>
                      </HelperText>
                    </FormHelperText>
                  )}
                </FormGroup>

                {packs.length > 0 && (
                  <FormGroup label="Skill Packs" fieldId="skill-packs" role="group">
                    <TagSelect
                      id="skill-packs"
                      color="purple"
                      placeholder="None: add Skill Packs"
                      options={packs.map((p) => ({
                        value: p.id,
                        description: `${p.description ? `${p.description} · ` : ''}${p.skills.map((s) => s.name).join(', ')}`,
                      }))}
                      selected={chosenPacks}
                      onChange={setChosenPacks}
                      isDisabled={submitting}
                    />
                    <FormHelperText>
                      <HelperText>
                        <HelperTextItem>Extra skills for the agent, on top of the Scan Profile's, e.g. for the codebase's language.</HelperTextItem>
                      </HelperText>
                    </FormHelperText>
                  </FormGroup>
                )}

                <FormGroup label="Model" fieldId="model">
                  <FormSelect id="model" value={model} onChange={(_e, v) => setModel(v)} isDisabled={submitting}>
                    {models.map((m) => (
                      <FormSelectOption
                        key={m.id}
                        value={m.id}
                        label={`${m.id} (${m.provider})${m.default ? ' — default' : ''}`}
                      />
                    ))}
                  </FormSelect>
                </FormGroup>

                {takesThinking && (
                  <FormGroup label="Thinking" fieldId="thinking" role="radiogroup">
                    <ToggleGroup aria-label="Thinking">
                      {([['', 'Model default'], ['on', 'On'], ['off', 'Off']] as const).map(([value, text]) => (
                        <ToggleGroupItem
                          key={value || 'default'}
                          text={text}
                          buttonId={`thinking-${value || 'default'}`}
                          isSelected={thinking === value}
                          onChange={() => setThinking(value)}
                          isDisabled={submitting}
                        />
                      ))}
                    </ToggleGroup>
                    <FormHelperText>
                      <HelperText>
                        <HelperTextItem>
                          Whether the model reasons before answering. Model default sends nothing; a model that cannot do what is
                          chosen fails its Attempts with the provider's message.
                        </HelperTextItem>
                      </HelperText>
                    </FormHelperText>
                  </FormGroup>
                )}

                {takesThinking && thinking === 'on' && (
                  <FormGroup label="Thinking level" fieldId="thinking-level">
                    <FormSelect
                      id="thinking-level"
                      value={thinkingLevel}
                      onChange={(_e, v) => setThinkingLevel(v as '' | ThinkingLevel)}
                      isDisabled={submitting}
                    >
                      <FormSelectOption value="" label="Model default" />
                      {THINKING_LEVELS.map((l) => (
                        <FormSelectOption key={l} value={l} label={l[0].toUpperCase() + l.slice(1)} />
                      ))}
                    </FormSelect>
                    <FormHelperText>
                      <HelperText>
                        <HelperTextItem>How much the model thinks. Some OpenAI-compatible servers, e.g. Qwen3 on vLLM, have no levels and ignore it.</HelperTextItem>
                      </HelperText>
                    </FormHelperText>
                  </FormGroup>
                )}

                <FormGroup label="Report language" fieldId="language">
                  <TextInput
                    id="language"
                    value={language}
                    placeholder="Server default, e.g. en"
                    onChange={(_e, v) => setLanguage(v)}
                    isDisabled={submitting}
                  />
                  <FormHelperText>
                    <HelperText>
                      <HelperTextItem>A language code such as en, it or pt-BR.</HelperTextItem>
                    </HelperText>
                  </FormHelperText>
                </FormGroup>

                <FormGroup label="Attempt timeout (minutes)" fieldId="attempt-timeout">
                  <TextInput
                    id="attempt-timeout"
                    type="number"
                    min={1}
                    max={1440}
                    value={timeout}
                    placeholder="Server default, e.g. 180"
                    onChange={(_e, v) => setTimeoutMinutes(v)}
                    validated={timeoutValid ? 'default' : 'error'}
                    isDisabled={submitting}
                  />
                  <FormHelperText>
                    <HelperText>
                      <HelperTextItem variant={timeoutValid ? 'default' : 'error'}>
                        How long each Attempt may run before it is stopped: 1 to 1440 minutes. A large codebase on a slow model needs hours.
                      </HelperTextItem>
                    </HelperText>
                  </FormHelperText>
                </FormGroup>

                <FormGroup label="Instructions" fieldId="instructions">
                  <TextArea
                    id="instructions"
                    value={instructions}
                    onChange={(_e, v) => setInstructions(v)}
                    placeholder="Optional: steer the analysis, e.g. focus on the payment module"
                    resizeOrientation="vertical"
                    isDisabled={submitting}
                  />
                </FormGroup>

                <FormGroup label="Scan id" isRequired fieldId="scan-id">
                  <InputGroup>
                    <InputGroupItem isFill>
                      <TextInput
                        id="scan-id"
                        value={id}
                        onChange={(_e, v) => setId(v)}
                        validated={idValid ? 'default' : 'error'}
                        isDisabled={submitting}
                      />
                    </InputGroupItem>
                    <InputGroupItem>
                      <Button variant="control" icon={<SyncAltIcon />} onClick={() => setId(newScanId())} aria-label="New random id" isDisabled={submitting} />
                    </InputGroupItem>
                  </InputGroup>
                  <FormHelperText>
                    <HelperText>
                      <HelperTextItem variant={idValid ? 'default' : 'error'}>
                        {idValid
                          ? 'Pick your own, or keep the random one.'
                          : '1-64 characters: lowercase letters, digits and dashes.'}
                      </HelperTextItem>
                    </HelperText>
                  </FormHelperText>
                </FormGroup>

                {submitError && (
                  <Alert variant="danger" isInline title="The Scan was not started">
                    {submitError}
                  </Alert>
                )}

                <ActionGroup>
                  <Button type="submit" variant="primary" isLoading={submitting} isDisabled={!canSubmit}>
                    Start Scan
                  </Button>
                  <Button variant="link" onClick={() => navigate({ page: 'scans' })} isDisabled={submitting}>
                    Cancel
                  </Button>
                </ActionGroup>
              </Form>
            )}
          </CardBody>
        </Card>
      </PageSection>
    </>
  );
}
