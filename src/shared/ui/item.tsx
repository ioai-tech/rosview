import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/shared/lib/utils"

const itemVariants = cva(
  "flex w-full items-start gap-3 rounded-lg text-left transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
  {
    variants: {
      variant: {
        default: "bg-transparent",
        outline: "border border-border bg-background",
        muted: "bg-muted/35",
      },
      size: {
        default: "px-3 py-2.5",
        sm: "px-2.5 py-2",
        xs: "px-2 py-1.5",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
)

type ItemRenderElement = React.ReactElement<
  React.HTMLAttributes<HTMLElement> & { className?: string }
>

interface ItemProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof itemVariants> {
  render?: ItemRenderElement
}

function mergeHandlers<T extends React.SyntheticEvent>(
  original?: (event: T) => void,
  next?: (event: T) => void,
) {
  return (event: T) => {
    original?.(event)
    next?.(event)
  }
}

const Item = React.forwardRef<HTMLDivElement, ItemProps>(
  ({ className, variant, size, render, children, onClick, ...props }, ref) => {
    const classes = cn(itemVariants({ variant, size }), className)
    if (render) {
      return React.cloneElement(render, {
        ...props,
        ...render.props,
        className: cn(classes, render.props.className),
        onClick: mergeHandlers(render.props.onClick, onClick),
        children,
      })
    }
    return (
      <div ref={ref} className={classes} onClick={onClick} {...props}>
        {children}
      </div>
    )
  },
)
Item.displayName = "Item"

const ItemGroup = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn("flex flex-col gap-1", className)} {...props} />
  ),
)
ItemGroup.displayName = "ItemGroup"

const ItemSeparator = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn("mx-2 h-px bg-border/70", className)} {...props} />
  ),
)
ItemSeparator.displayName = "ItemSeparator"

const ItemMedia = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & {
    variant?: "default" | "icon" | "avatar" | "image"
  }
>(({ className, variant = "default", ...props }, ref) => (
  <div
    ref={ref}
    className={cn(
      "shrink-0 text-muted-foreground",
      variant === "icon" && "mt-0.5 flex size-7 items-center justify-center rounded-md bg-muted/60",
      variant === "avatar" && "size-8 overflow-hidden rounded-full",
      variant === "image" && "overflow-hidden rounded-md",
      className,
    )}
    {...props}
  />
))
ItemMedia.displayName = "ItemMedia"

const ItemContent = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn("min-w-0 flex-1", className)} {...props} />
  ),
)
ItemContent.displayName = "ItemContent"

const ItemTitle = React.forwardRef<HTMLParagraphElement, React.HTMLAttributes<HTMLParagraphElement>>(
  ({ className, ...props }, ref) => (
    <p ref={ref} className={cn("truncate text-sm font-medium text-foreground", className)} {...props} />
  ),
)
ItemTitle.displayName = "ItemTitle"

const ItemDescription = React.forwardRef<HTMLParagraphElement, React.HTMLAttributes<HTMLParagraphElement>>(
  ({ className, ...props }, ref) => (
    <p
      ref={ref}
      className={cn("mt-0.5 truncate text-xs text-muted-foreground", className)}
      {...props}
    />
  ),
)
ItemDescription.displayName = "ItemDescription"

const ItemActions = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn("ml-2 shrink-0", className)} {...props} />
  ),
)
ItemActions.displayName = "ItemActions"

const ItemHeader = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn("col-span-full text-xs font-medium uppercase tracking-wide text-muted-foreground", className)}
      {...props}
    />
  ),
)
ItemHeader.displayName = "ItemHeader"

const ItemFooter = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn("col-span-full text-xs text-muted-foreground", className)} {...props} />
  ),
)
ItemFooter.displayName = "ItemFooter"

export {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemFooter,
  ItemGroup,
  ItemHeader,
  ItemMedia,
  ItemSeparator,
  ItemTitle,
}
