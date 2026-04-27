import { useState, useEffect } from "react";

export type ProductMode = "surveys" | "interviews" | "kids";

export function useProductMode() {
  const [mode, setMode] = useState<ProductMode>(() => {
    return (localStorage.getItem("product_mode") as ProductMode) || "surveys";
  });

  useEffect(() => {
    const handleStorageChange = (e: StorageEvent) => {
      if (e.key === "product_mode") {
        setMode((e.newValue as ProductMode) || "surveys");
      }
    };
    const handleCustomEvent = (e: CustomEvent) => {
      setMode(e.detail as ProductMode);
    };

    window.addEventListener("storage", handleStorageChange);
    window.addEventListener("product_mode_changed" as any, handleCustomEvent);

    return () => {
      window.removeEventListener("storage", handleStorageChange);
      window.removeEventListener("product_mode_changed" as any, handleCustomEvent);
    };
  }, []);

  const updateMode = (newMode: ProductMode) => {
    localStorage.setItem("product_mode", newMode);
    setMode(newMode);
    window.dispatchEvent(new CustomEvent("product_mode_changed", { detail: newMode }));
  };

  return [mode, updateMode] as const;
}
