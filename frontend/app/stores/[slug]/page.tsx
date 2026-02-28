import { redirect } from "next/navigation";

interface Props {
  params: {
    slug: string;
  };
}

export default function StoreDetailPage({ params }: Props): never {
  redirect(`/ops/${encodeURIComponent(params.slug)}`);
}
