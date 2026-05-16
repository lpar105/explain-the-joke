import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "../../lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap border-2 border-[#1a1a1a] text-[10px] font-black uppercase tracking-[0.18em] transition duration-150 disabled:pointer-events-none disabled:opacity-60 [&_svg]:pointer-events-none [&_svg]:size-4 shrink-0 outline-none focus-visible:ring-2 focus-visible:ring-[#1a1a1a]/25",
  {
    variants: {
      variant: {
        default:
          "bg-[#1a3a52] text-[#faf8f5] hover:-translate-x-1 hover:-translate-y-1 hover:bg-[#2a4a62] hover:shadow-[4px_4px_0px_0px_#1a1a1a]",
        destructive:
          "bg-[#c41e3a] text-[#faf8f5] hover:-translate-x-1 hover:-translate-y-1 hover:bg-[#d63a52] hover:shadow-[4px_4px_0px_0px_#1a1a1a]",
        outline:
          "bg-white text-[#1a1a1a] hover:-translate-x-1 hover:-translate-y-1 hover:bg-[#f0ede8] hover:shadow-[4px_4px_0px_0px_#1a1a1a]",
        ghost: "bg-transparent text-[#1a1a1a] hover:bg-[#f0ede8]",
      },
      size: {
        default: "h-11 px-4 py-2",
        sm: "h-9 px-3 py-2",
        lg: "h-12 px-5 py-3",
        icon: "size-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  }) {
  const Comp = asChild ? Slot : "button";

  return (
    <Comp
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
