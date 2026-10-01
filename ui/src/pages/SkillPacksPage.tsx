import {
  Alert,
  AlertActionCloseButton,
  Button,
  Checkbox,
  Content,
  EmptyState,
  EmptyStateBody,
  Form,
  FormGroup,
  FormHelperText,
  HelperText,
  HelperTextItem,
  Label,
  LabelGroup,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  PageSection,
  SearchInput,
  Skeleton,
  TextArea,
  TextInput,
  Title,
  Toolbar,
  ToolbarContent,
  ToolbarItem,
} from '@patternfly/react-core';
import CubesIcon from '@patternfly/react-icons/dist/esm/icons/cubes-icon';
import { ActionsColumn, Table, Tbody, Td, Th, Thead, Tr } from '@patternfly/react-table';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, type LibrarySkill, type SkillPack } from '../api';
import { href } from '../router';

/** Skill Packs: named groups of library skills a caller can add to a Scan (ADR-0008). */
export function SkillPacksPage() {
  const [packs, setPacks] = useState<SkillPack[]>();
  const [skills, setSkills] = useState<LibrarySkill[]>([]);
  const [error, setError] = useState<string>();
  const [editing, setEditing] = useState<SkillPack | 'new'>();

  const load = useCallback(() => {
    Promise.all([api.skillPacks(), api.librarySkills()])
      .then(([p, s]) => {
        setPacks(p);
        setSkills(s);
      })
      .catch((e: Error) => setError(e.message));
  }, []);
  useEffect(load, [load]);

  async function remove(id: string) {
    setError(undefined);
    try {
      await api.deleteSkillPack(id);
    } catch (e) {
      setError((e as Error).message);
    }
    load();
  }

  return (
    <>
      <PageSection>
        <Content>
          <Title headingLevel="h1">Skill Packs</Title>
          <p>
            Groups of skills, for instance per language or framework. A caller adds packs to a Scan, on top of its Scan
            Profile's own skills; each Scan keeps the copy it started with.
          </p>
        </Content>
      </PageSection>
      <PageSection isFilled>
        {error && (
          <Alert variant="danger" isInline title="Something went wrong" className="pf-v6-u-mb-md" actionClose={<AlertActionCloseButton onClose={() => setError(undefined)} />}>
            {error}
          </Alert>
        )}
        <Toolbar>
          <ToolbarContent>
            <ToolbarItem>
              <Button variant="primary" onClick={() => setEditing('new')} isDisabled={!skills.length}>
                Create Skill Pack
              </Button>
            </ToolbarItem>
            {packs && !skills.length && (
              <ToolbarItem>
                <Button variant="link" component="a" href={href({ page: 'skills' })}>
                  Import skills first
                </Button>
              </ToolbarItem>
            )}
          </ToolbarContent>
        </Toolbar>
        {!packs ? (
          !error && <Skeleton height="120px" screenreaderText="Loading" />
        ) : packs.length === 0 ? (
          <EmptyState titleText="No Skill Packs" headingLevel="h2" icon={CubesIcon}>
            <EmptyStateBody>Create one from the skills of the library.</EmptyStateBody>
          </EmptyState>
        ) : (
          <Table aria-label="Skill Packs" variant="compact">
            <Thead>
              <Tr>
                <Th>Id</Th>
                <Th>Description</Th>
                <Th>Skills</Th>
                <Th screenReaderText="Actions" />
              </Tr>
            </Thead>
            <Tbody>
              {packs.map((p) => (
                <Tr key={p.id}>
                  <Td dataLabel="Id">
                    <strong>{p.id}</strong>
                  </Td>
                  <Td dataLabel="Description">{p.description || <span className="app-subtle">—</span>}</Td>
                  <Td dataLabel="Skills">
                    <LabelGroup numLabels={6}>
                      {p.skills.map((s) => (
                        <Label key={s.name} isCompact>
                          {s.name}
                        </Label>
                      ))}
                    </LabelGroup>
                  </Td>
                  <Td isActionCell>
                    <ActionsColumn
                      items={[
                        { title: 'Edit', onClick: () => setEditing(p) },
                        { isSeparator: true },
                        { title: 'Remove', onClick: () => remove(p.id) },
                      ]}
                    />
                  </Td>
                </Tr>
              ))}
            </Tbody>
          </Table>
        )}
      </PageSection>

      {editing && (
        <PackForm
          pack={editing === 'new' ? undefined : editing}
          library={skills}
          onClose={() => setEditing(undefined)}
          onSaved={() => {
            setEditing(undefined);
            load();
          }}
        />
      )}
    </>
  );
}

function PackForm({ pack, library, onClose, onSaved }: { pack?: SkillPack; library: LibrarySkill[]; onClose: () => void; onSaved: () => void }) {
  const [id, setId] = useState(pack?.id ?? '');
  const [description, setDescription] = useState(pack?.description ?? '');
  const [chosen, setChosen] = useState(new Set(pack?.skills.map((s) => s.name) ?? []));
  const [filter, setFilter] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  const toggle = (name: string, on: boolean) =>
    setChosen((prev) => {
      const next = new Set(prev);
      if (on) next.add(name);
      else next.delete(name);
      return next;
    });

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(undefined);
    try {
      const skills = [...chosen];
      if (pack) await api.updateSkillPack(pack.id, { description, skills });
      else await api.createSkillPack({ id: id.trim(), description, skills });
      onSaved();
    } catch (e) {
      setError((e as Error).message);
      setSaving(false);
    }
  }

  const needle = filter.trim().toLowerCase();
  const shown = library.filter((s) => !needle || `${s.name} ${s.description}`.toLowerCase().includes(needle));

  return (
    <Modal variant="medium" isOpen onClose={onClose} aria-labelledby="pack-form">
      <ModalHeader title={pack ? `Edit ${pack.id}` : 'Create a Skill Pack'} labelId="pack-form" />
      <ModalBody>
        <Form id="pack-form-body" onSubmit={submit}>
          {!pack && (
            <FormGroup label="Id" isRequired fieldId="pack-id">
              <TextInput id="pack-id" value={id} onChange={(_e, v) => setId(v)} placeholder="java" isRequired />
              <FormHelperText>
                <HelperText>
                  <HelperTextItem>What callers pass in `skillPacks`: lowercase letters, digits and dashes.</HelperTextItem>
                </HelperText>
              </FormHelperText>
            </FormGroup>
          )}
          <FormGroup label="Description" fieldId="pack-description">
            <TextArea id="pack-description" value={description} onChange={(_e, v) => setDescription(v)} placeholder="When to add it, e.g. Java and Spring codebases" resizeOrientation="vertical" />
          </FormGroup>
          <FormGroup label={`Skills (${chosen.size} chosen)`} isRequired fieldId="pack-skills" role="group">
            <SearchInput placeholder="Filter skills" value={filter} onChange={(_e, v) => setFilter(v)} onClear={() => setFilter('')} />
            <div className="app-modal-scroll app-checklist">
              {shown.map((s) => (
                <Checkbox
                  key={s.name}
                  id={`pack-skill-${s.name}`}
                  label={<code>{s.name}</code>}
                  description={s.description}
                  isChecked={chosen.has(s.name)}
                  onChange={(_e, on) => toggle(s.name, on)}
                />
              ))}
            </div>
          </FormGroup>
          {error && (
            <Alert variant="danger" isInline title="Not saved">
              {error}
            </Alert>
          )}
        </Form>
      </ModalBody>
      <ModalFooter>
        <Button variant="primary" type="submit" form="pack-form-body" isLoading={saving} isDisabled={saving || !chosen.size || (!pack && !id.trim())}>
          {pack ? 'Save' : 'Create'}
        </Button>
        <Button variant="link" onClick={onClose}>
          Cancel
        </Button>
      </ModalFooter>
    </Modal>
  );
}
