import * as React from "react";

import { cn } from "../../lib/utils";

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "flex h-11 w-full border-2 border-[#1a1a1a] bg-white px-3 py-2 text-sm font-medium text-[#1a1a1a] outline-none placeholder:text-[#9b948b] focus:shadow-[4px_4px_0px_0px_#1a1a1a]",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
