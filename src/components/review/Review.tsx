import { useT } from "../../i18n";
import { Card, Title } from "../ui";

export default function Review() {
  const t = useT().review;
  return (
    <Card>
      <Title>{t.title}</Title>
      <p className="muted">{t.notYet}</p>
    </Card>
  );
}
