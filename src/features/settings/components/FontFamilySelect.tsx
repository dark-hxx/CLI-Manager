import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Select, type SelectProps } from "@mantine/core";
import type { FontFamilyOption } from "../../../shared/platform/systemFonts";

const FONT_SELECT_PAGE_SIZE = 80;
const SCROLL_APPEND_THRESHOLD_PX = 48;

type FontFamilySelectProps = Omit<
  SelectProps<string>,
  "data" | "filter" | "limit" | "searchable" | "scrollAreaProps" | "searchValue" | "onSearchChange"
> & {
  data: readonly FontFamilyOption[];
  pageSize?: number;
};

function getNormalizedSearch(search: string, selectedOption: FontFamilyOption | null) {
  const trimmed = search.trim();
  if (!trimmed || trimmed === selectedOption?.label.trim()) return "";
  return trimmed.toLowerCase();
}

function optionMatchesSearch(option: FontFamilyOption, normalizedSearch: string) {
  if (!normalizedSearch) return true;
  return option.label.toLowerCase().includes(normalizedSearch) || option.value.toLowerCase().includes(normalizedSearch);
}

function includeSelectedOption(
  options: FontFamilyOption[],
  selectedOption: FontFamilyOption | null,
  normalizedSearch: string,
  visibleCount: number
) {
  if (!selectedOption || options.some((option) => option.value === selectedOption.value)) return options;
  if (!optionMatchesSearch(selectedOption, normalizedSearch)) return options;

  if (options.length >= visibleCount) {
    return [selectedOption, ...options.slice(0, Math.max(visibleCount - 1, 0))];
  }

  return [selectedOption, ...options];
}

export function FontFamilySelect({
  data,
  pageSize = FONT_SELECT_PAGE_SIZE,
  value,
  onDropdownOpen,
  onDropdownClose,
  ...props
}: FontFamilySelectProps) {
  const selectedOption = useMemo(() => data.find((option) => option.value === value) ?? null, [data, value]);
  const [searchValue, setSearchValue] = useState(() => selectedOption?.label ?? "");
  const [visibleCount, setVisibleCount] = useState(pageSize);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const isDropdownOpenRef = useRef(false);

  useEffect(() => {
    setSearchValue(selectedOption?.label ?? "");
    setVisibleCount(pageSize);
  }, [pageSize, selectedOption?.label]);

  const normalizedSearch = useMemo(
    () => getNormalizedSearch(searchValue, selectedOption),
    [searchValue, selectedOption]
  );

  const filteredOptions = useMemo(
    () => data.filter((option) => optionMatchesSearch(option, normalizedSearch)),
    [data, normalizedSearch]
  );

  const visibleOptions = useMemo(
    () => includeSelectedOption(filteredOptions.slice(0, visibleCount), selectedOption, normalizedSearch, visibleCount),
    [filteredOptions, normalizedSearch, selectedOption, visibleCount]
  );

  const revealNextPage = useCallback(() => {
    setVisibleCount((current) => Math.min(filteredOptions.length, current + pageSize));
  }, [filteredOptions.length, pageSize]);

  const handleSearchChange = useCallback(
    (nextSearch: string) => {
      setSearchValue(nextSearch);
      setVisibleCount(pageSize);
    },
    [pageSize]
  );

  const handleDropdownOpen = useCallback(() => {
    if (!isDropdownOpenRef.current) {
      setVisibleCount(pageSize);
      isDropdownOpenRef.current = true;
    }
    onDropdownOpen?.();
  }, [onDropdownOpen, pageSize]);

  const handleDropdownClose = useCallback(() => {
    isDropdownOpenRef.current = false;
    setSearchValue(selectedOption?.label ?? "");
    setVisibleCount(pageSize);
    onDropdownClose?.();
  }, [onDropdownClose, pageSize, selectedOption?.label]);

  return (
    <Select<string>
      {...props}
      value={value}
      data={visibleOptions}
      allowDeselect={false}
      searchable
      searchValue={searchValue}
      onSearchChange={handleSearchChange}
      onDropdownOpen={handleDropdownOpen}
      onDropdownClose={handleDropdownClose}
      filter={({ options }) => options}
      limit={visibleOptions.length}
      scrollAreaProps={{
        viewportRef,
        onScrollPositionChange: ({ y }) => {
          const viewport = viewportRef.current;
          if (!viewport) return;

          const remainingScroll = viewport.scrollHeight - viewport.clientHeight - y;
          if (remainingScroll <= SCROLL_APPEND_THRESHOLD_PX) {
            revealNextPage();
          }
        },
      }}
    />
  );
}
