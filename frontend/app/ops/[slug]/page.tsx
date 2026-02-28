import StoreOpsDashboard from "@/components/StoreOpsDashboard";

interface Props {
  params: {
    slug: string;
  };
}

export default function OpsDetailPage({ params }: Props): JSX.Element {
  return <StoreOpsDashboard slug={params.slug} />;
}
