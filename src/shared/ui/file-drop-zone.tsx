import * as React from 'react';
import { Upload } from 'lucide-react';

import { cn } from '@/shared/lib/utils';
import { Button } from '@/shared/ui/button';

export type FileDropZoneProps = {
  accept?: string;
  multiple?: boolean;
  directory?: boolean;
  disabled?: boolean;
  onFiles: (files: File[]) => void;
  title: string;
  hint?: string;
  browseLabel: string;
  selectedLabel?: string;
  error?: string | null;
  testId?: string;
  className?: string;
};

export const FileDropZone: React.FC<FileDropZoneProps> = ({
  accept,
  multiple = false,
  directory = false,
  disabled = false,
  onFiles,
  title,
  hint,
  browseLabel,
  selectedLabel,
  error,
  testId,
  className,
}) => {
  const inputRef = React.useRef<HTMLInputElement>(null);
  const dragDepthRef = React.useRef(0);
  const [dragActive, setDragActive] = React.useState(false);

  const clearDragState = React.useCallback(() => {
    dragDepthRef.current = 0;
    setDragActive(false);
  }, []);

  const emitFiles = React.useCallback(
    (files: File[]) => {
      if (disabled || files.length === 0) return;
      onFiles(files);
    },
    [disabled, onFiles],
  );

  const handleInputChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    emitFiles(files);
    event.target.value = '';
  };

  const handleDragEnter = (event: React.DragEvent<HTMLDivElement>) => {
    if (disabled || !Array.from(event.dataTransfer.types).includes('Files')) return;
    event.preventDefault();
    event.stopPropagation();
    dragDepthRef.current += 1;
    setDragActive(true);
  };

  const handleDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    if (disabled || !Array.from(event.dataTransfer.types).includes('Files')) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'copy';
  };

  const handleDragLeave = (event: React.DragEvent<HTMLDivElement>) => {
    if (disabled) return;
    event.preventDefault();
    event.stopPropagation();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) {
      setDragActive(false);
    }
  };

  const handleDrop = (event: React.DragEvent<HTMLDivElement>) => {
    if (disabled || !Array.from(event.dataTransfer.types).includes('Files')) return;
    event.preventDefault();
    event.stopPropagation();
    clearDragState();
    emitFiles(Array.from(event.dataTransfer.files));
  };

  const openPicker = () => {
    if (disabled) return;
    inputRef.current?.click();
  };

  return (
    <div className={cn('space-y-1', className)}>
      <div
        role="button"
        tabIndex={disabled ? -1 : 0}
        aria-disabled={disabled}
        className={cn(
          'flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed px-3 py-4 text-center transition-colors',
          disabled && 'cursor-not-allowed opacity-50',
          !disabled && 'cursor-pointer hover:border-primary/50 hover:bg-muted/30',
          dragActive && !disabled && 'border-primary bg-muted/50',
          error ? 'border-destructive/50' : 'border-border',
        )}
        onClick={openPicker}
        onKeyDown={(event) => {
          if (disabled) return;
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            openPicker();
          }
        }}
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <Upload className="h-5 w-5 text-muted-foreground" aria-hidden />
        <div className="space-y-0.5">
          <div className="text-xs font-medium">{title}</div>
          {hint ? <div className="text-[10px] text-muted-foreground">{hint}</div> : null}
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 text-xs pointer-events-none"
          tabIndex={-1}
          disabled={disabled}
        >
          {browseLabel}
        </Button>
        <input
          ref={inputRef}
          type="file"
          className="hidden"
          accept={accept}
          multiple={multiple || directory}
          data-testid={testId}
          disabled={disabled}
          {...(directory
            ? ({ webkitdirectory: '', directory: '' } as React.InputHTMLAttributes<HTMLInputElement>)
            : {})}
          onChange={handleInputChange}
          onClick={(event) => event.stopPropagation()}
        />
      </div>
      {selectedLabel ? (
        <div className="text-[10px] text-muted-foreground truncate" title={selectedLabel}>
          {selectedLabel}
        </div>
      ) : null}
      {error ? <div className="text-[10px] text-red-500">{error}</div> : null}
    </div>
  );
};
