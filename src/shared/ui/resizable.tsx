import { GripVertical } from "lucide-react"
import { Group, Panel, Separator, type GroupProps, type PanelProps, type SeparatorProps } from "react-resizable-panels"

import { cn } from "@/shared/lib/utils"

const ResizablePanelGroup = ({ className, ...props }: GroupProps) => (
  <Group
    className={cn(
      "min-h-0 min-w-0 flex-1 data-[panel-group-direction=vertical]:flex-col",
      className,
    )}
    {...props}
  />
)

const ResizablePanel = ({ className, ...props }: PanelProps) => (
  <Panel className={cn("min-h-0 min-w-0", className)} {...props} />
)

const ResizableHandle = ({
  className,
  withHandle,
  ...props
}: SeparatorProps & {
  withHandle?: boolean
}) => (
  <Separator
    className={cn(
      "relative hidden h-full w-0.5 shrink-0 bg-border/70 transition-colors hover:bg-primary/60 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 md:block aria-[orientation=horizontal]:h-0.5 aria-[orientation=horizontal]:w-full",
      className,
    )}
    {...props}
  >
    {withHandle ? (
      <div className="absolute left-1/2 top-1/2 z-10 flex h-6 w-4 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-sm border border-border bg-background">
        <GripVertical className="h-3.5 w-3.5 text-muted-foreground" />
      </div>
    ) : null}
  </Separator>
)

export { ResizableHandle, ResizablePanel, ResizablePanelGroup }
