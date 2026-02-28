import Link from "next/link";
import styles from "@/components/SiteHeader.module.css";

interface SiteHeaderProps {
  active?: "home" | "stores";
}

export default function SiteHeader({ active }: SiteHeaderProps): JSX.Element {
  return (
    <header className={styles.header}>
      <Link href="/" className={styles.brand}>
        <div className={styles.brandIcon} />
        <span>ShopMCP</span>
      </Link>
      <nav className={styles.nav}>
        <Link href="/" className={active === "home" ? styles.active : ""}>
          Home
        </Link>
        <Link href="/stores" className={active === "stores" ? styles.active : ""}>
          Stores
        </Link>
        <a href="https://modelcontextprotocol.io/introduction" target="_blank" rel="noreferrer">
          Docs
        </a>
        <a href="https://github.com/potatoman03/shopmcp" target="_blank" rel="noreferrer">
          Source
        </a>
      </nav>
    </header>
  );
}
