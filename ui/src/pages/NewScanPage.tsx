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
import { api, SCAN_ID_PATTERN, type Model, type Profile, type SkillPack } from '../api';
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
  const [language, setLanguage] = useState('');
  const [instructions, setInstructions] = useState('');
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
  const canSubmit = idValid && Boolean(profile) && hasSource && !submitting;
  const selectedProfile = profiles?.find((p) => p.name === profile);

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
        language: language.trim(),
        instructions: instructions.trim(),
        skillPacks: chosenPacks,
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
