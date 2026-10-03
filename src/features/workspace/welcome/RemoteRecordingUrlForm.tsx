import React, { useState } from 'react';
import { useIntl } from 'react-intl';
import { AlertCircle, Globe2 } from 'lucide-react';
import { Button } from '@/shared/ui/button';
import { Input } from '@/shared/ui/input';

function pathnameFromUrl(trimmedUrl: string): string {
  try {
    return new URL(trimmedUrl).pathname.toLowerCase();
  } catch {
    return trimmedUrl.split('#')[0].split('?')[0].toLowerCase();
  }
}

function isSupportedRemoteRecording(pathnameLower: string): boolean {
  return (
    pathnameLower.endsWith('.mcap') ||
    pathnameLower.endsWith('.bag') ||
    pathnameLower.endsWith('.db3') ||
    pathnameLower.endsWith('.hdf5') ||
    pathnameLower.endsWith('.h5') ||
    pathnameLower.endsWith('.tar') ||
    pathnameLower.endsWith('.tar.gz') ||
    pathnameLower.endsWith('.tgz')
  );
}

interface RemoteRecordingUrlFormProps {
  initialUrl?: string;
  onSubmit: (url: string) => void;
  isLoading?: boolean;
}

export const RemoteRecordingUrlForm: React.FC<RemoteRecordingUrlFormProps> = ({
  initialUrl = '',
  onSubmit,
  isLoading = false,
}) => {
  const { formatMessage } = useIntl();
  const [url, setUrl] = useState(initialUrl);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const trimmedUrl = url.trim();
    if (!trimmedUrl) {
      setError(formatMessage({ id: 'welcome.remoteUrlErrorRequired' }));
      return;
    }
    if (!trimmedUrl.startsWith('http://') && !trimmedUrl.startsWith('https://')) {
      setError(formatMessage({ id: 'welcome.remoteUrlErrorInvalid' }));
      return;
    }
    const pathnameLower = pathnameFromUrl(trimmedUrl);
    if (!isSupportedRemoteRecording(pathnameLower)) {
      setError(formatMessage({ id: 'welcome.remoteUrlErrorUnsupported' }));
      return;
    }
    onSubmit(trimmedUrl);
  };

  return (
    <form onSubmit={handleSubmit} className="w-full space-y-4">
      <div className="relative">
        <Globe2
          className="pointer-events-none absolute left-3 top-1/2 z-1 h-4 w-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <Input
          className="h-11 border-0 bg-muted/25 pl-9 shadow-none focus-visible:ring-1 focus-visible:ring-muted-foreground/30 focus-visible:ring-offset-0"
          placeholder={formatMessage({ id: 'welcome.remoteUrlPlaceholder' })}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          disabled={isLoading}
          autoFocus
          aria-invalid={error != null}
          aria-describedby={error ? 'remote-url-error' : undefined}
        />
      </div>
      {error ? (
        <p id="remote-url-error" className="flex items-center gap-1.5 text-xs text-destructive" role="alert">
          <AlertCircle className="h-3.5 w-3.5 shrink-0" aria-hidden />
          {error}
        </p>
      ) : null}
      <div className="flex justify-end">
        <Button type="submit" size="sm" disabled={isLoading || !url.trim()}>
          {isLoading ? formatMessage({ id: 'welcome.opening' }) : formatMessage({ id: 'welcome.open' })}
        </Button>
      </div>
    </form>
  );
};
