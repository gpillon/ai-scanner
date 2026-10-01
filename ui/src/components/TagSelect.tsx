import {
  Button,
  Label,
  LabelGroup,
  MenuToggle,
  Select,
  SelectList,
  SelectOption,
  TextInputGroup,
  TextInputGroupMain,
  TextInputGroupUtilities,
} from '@patternfly/react-core';
import TimesIcon from '@patternfly/react-icons/dist/esm/icons/times-icon';
import { useRef, useState, type KeyboardEvent } from 'react';

export interface TagOption {
  value: string;
  description?: string;
}

/**
 * A field of tags: the chosen values show as labels, and clicking it opens a filterable list
 * to add more (PatternFly's multiple typeahead with labels).
 */
export function TagSelect({
  id,
  options,
  selected,
  onChange,
  placeholder,
  isDisabled,
  color,
}: {
  id: string;
  options: TagOption[];
  selected: string[];
  onChange: (selected: string[]) => void;
  placeholder?: string;
  isDisabled?: boolean;
  color?: 'purple' | 'blue' | 'grey';
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const [focused, setFocused] = useState<number>();
  const input = useRef<HTMLInputElement>(null);

  const needle = filter.trim().toLowerCase();
  const shown = options.filter((o) => !needle || `${o.value} ${o.description ?? ''}`.toLowerCase().includes(needle));

  const toggle = (value: string) => {
    onChange(selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value]);
    setFilter('');
    input.current?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setOpen(true);
      if (!shown.length) return;
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setFocused((i) => (i === undefined ? (step > 0 ? 0 : shown.length - 1) : (i + step + shown.length) % shown.length));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const option = focused !== undefined ? shown[focused] : shown.length === 1 ? shown[0] : undefined;
      if (open && option) toggle(option.value);
      else setOpen(true);
    } else if (event.key === 'Backspace' && !filter && selected.length) {
      onChange(selected.slice(0, -1));
    } else if (event.key === 'Escape') {
      setOpen(false);
    }
  };

  return (
    <Select
      id={`${id}-select`}
      role="menu"
      isOpen={open}
      onSelect={(_e, value) => value !== undefined && toggle(String(value))}
      onOpenChange={(isOpen) => {
        setOpen(isOpen);
        if (!isOpen) setFocused(undefined);
      }}
      toggle={(ref) => (
        <MenuToggle
          ref={ref}
          variant="typeahead"
          aria-label={placeholder}
          onClick={() => {
            setOpen(!open);
            input.current?.focus();
          }}
          isExpanded={open}
          isDisabled={isDisabled}
          isFullWidth
        >
          <TextInputGroup isPlain>
            <TextInputGroupMain
              inputId={id}
              value={filter}
              onClick={() => setOpen(true)}
              onChange={(_e, v) => {
                setFilter(v);
                setFocused(undefined);
                setOpen(true);
              }}
              onKeyDown={onKeyDown}
              innerRef={input}
              placeholder={selected.length ? undefined : placeholder}
              role="combobox"
              isExpanded={open}
              aria-controls={`${id}-listbox`}
              autoComplete="off"
            >
              {selected.length > 0 && (
                <LabelGroup numLabels={8}>
                  {selected.map((value) => (
                    <Label
                      key={value}
                      color={color}
                      onClose={(e) => {
                        e.stopPropagation();
                        toggle(value);
                      }}
                    >
                      {value}
                    </Label>
                  ))}
                </LabelGroup>
              )}
            </TextInputGroupMain>
            {(selected.length > 0 || filter) && (
              <TextInputGroupUtilities>
                <Button
                  variant="plain"
                  aria-label="Clear"
                  icon={<TimesIcon />}
                  onClick={() => {
                    setFilter('');
                    onChange([]);
                    input.current?.focus();
                  }}
                />
              </TextInputGroupUtilities>
            )}
          </TextInputGroup>
        </MenuToggle>
      )}
    >
      <SelectList isAriaMultiselectable id={`${id}-listbox`}>
        {shown.length ? (
          shown.map((o, i) => (
            <SelectOption
              key={o.value}
              value={o.value}
              hasCheckbox
              isSelected={selected.includes(o.value)}
              isFocused={focused === i}
              description={o.description}
            >
              {o.value}
            </SelectOption>
          ))
        ) : (
          <SelectOption isDisabled>No match for "{filter}"</SelectOption>
        )}
      </SelectList>
    </Select>
  );
}
