import { BottomNav } from "./BottomNav";

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-background text-foreground font-sans flex flex-col">
      {/* 
        Increased bottom padding to pb-40 (10rem / 160px) to ensure the 
        floating bottom navigation bar (fixed at bottom) never covers 
        the "Find Match" or other action buttons at the bottom of pages.
      */}
      <div className="flex-1 pb-40 container mx-auto max-w-md px-4 pt-6">
        {children}
      </div>
      <BottomNav />
    </div>
  );
}
