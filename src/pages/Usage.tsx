import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ArrowLeft, BarChart3, Users, Activity } from "lucide-react";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from "recharts";
import hdfcLogo from "@/assets/hdfc-logo.png";

interface UsageRow {
  id: string;
  created_at: string;
  user_name: string;
  action: string;
  node_count: number;
  category_count: number;
}

interface ChartData {
  date: string;
  [user: string]: string | number;
}

const Usage = () => {
  const [usageData, setUsageData] = useState<UsageRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [granularity, setGranularity] = useState<"daily" | "monthly">("daily");
  const navigate = useNavigate();

  useEffect(() => {
    fetchUsage();
  }, []);

  const fetchUsage = async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from("plugin_usage")
      .select("*")
      .order("created_at", { ascending: true });

    if (!error && data) {
      setUsageData(data);
    }
    setLoading(false);
  };

  const getChartData = (): ChartData[] => {
    if (usageData.length === 0) return [];

    const grouped: Record<string, Record<string, number>> = {};
    const allUsers = new Set<string>();

    usageData.forEach((row) => {
      const d = new Date(row.created_at);
      const key =
        granularity === "daily"
          ? d.toISOString().split("T")[0]
          : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      const user = row.user_name || "anonymous";
      allUsers.add(user);

      if (!grouped[key]) grouped[key] = {};
      grouped[key][user] = (grouped[key][user] || 0) + 1;
    });

    return Object.entries(grouped)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, users]) => ({
        date,
        ...users,
      }));
  };

  const users = [...new Set(usageData.map((r) => r.user_name || "anonymous"))];
  const chartData = getChartData();

  // Generate distinct colors per user
  const userColors: Record<string, string> = {};
  const hueStep = users.length > 0 ? 360 / users.length : 0;
  users.forEach((user, i) => {
    userColors[user] = `hsl(${Math.round(hueStep * i + 220) % 360}, 70%, 55%)`;
  });

  const totalAnalyses = usageData.length;
  const uniqueUsers = users.length;
  const totalNodes = usageData.reduce((s, r) => s + (r.node_count || 0), 0);

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b border-border bg-card">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center gap-4">
          <Button variant="ghost" size="icon" onClick={() => navigate("/")}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <img src={hdfcLogo} alt="Logo" className="h-8 w-8" />
          <div>
            <h1 className="text-lg font-bold text-foreground">Plugin Usage</h1>
            <p className="text-xs text-muted-foreground">
              Track analysis activity across users
            </p>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-6 py-8 space-y-6">
        {/* Stats */}
        <div className="grid grid-cols-3 gap-4">
          <Card className="p-5 shadow-[var(--shadow-card)]">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-primary/10">
                <Activity className="h-5 w-5 text-primary" />
              </div>
              <div>
                <p className="text-2xl font-bold text-foreground">{totalAnalyses}</p>
                <p className="text-xs text-muted-foreground">Total Analyses</p>
              </div>
            </div>
          </Card>
          <Card className="p-5 shadow-[var(--shadow-card)]">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-accent/10">
                <Users className="h-5 w-5 text-accent" />
              </div>
              <div>
                <p className="text-2xl font-bold text-foreground">{uniqueUsers}</p>
                <p className="text-xs text-muted-foreground">Unique Users</p>
              </div>
            </div>
          </Card>
          <Card className="p-5 shadow-[var(--shadow-card)]">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-warning/10">
                <BarChart3 className="h-5 w-5 text-warning" />
              </div>
              <div>
                <p className="text-2xl font-bold text-foreground">
                  {totalNodes.toLocaleString()}
                </p>
                <p className="text-xs text-muted-foreground">Nodes Analyzed</p>
              </div>
            </div>
          </Card>
        </div>

        {/* Chart */}
        <Card className="p-6 shadow-[var(--shadow-card)]">
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-lg font-semibold text-foreground">
              Uses Per User
            </h2>
            <Tabs value={granularity} onValueChange={(v) => setGranularity(v as "daily" | "monthly")}>
              <TabsList>
                <TabsTrigger value="daily">Daily</TabsTrigger>
                <TabsTrigger value="monthly">Monthly</TabsTrigger>
              </TabsList>
            </Tabs>
          </div>

          {loading ? (
            <div className="h-64 flex items-center justify-center text-muted-foreground">
              Loading...
            </div>
          ) : chartData.length === 0 ? (
            <div className="h-64 flex items-center justify-center text-muted-foreground">
              No usage data yet. Use the plugin to start tracking!
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={350}>
              <BarChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis
                  dataKey="date"
                  tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
                />
                <YAxis
                  allowDecimals={false}
                  tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
                />
                <Tooltip
                  contentStyle={{
                    background: "hsl(var(--card))",
                    border: "1px solid hsl(var(--border))",
                    borderRadius: 8,
                    fontSize: 12,
                  }}
                />
                <Legend />
                {users.map((user) => (
                  <Bar
                    key={user}
                    dataKey={user}
                    stackId="a"
                    fill={userColors[user]}
                    radius={[2, 2, 0, 0]}
                  />
                ))}
              </BarChart>
            </ResponsiveContainer>
          )}
        </Card>

        {/* Recent Activity */}
        <Card className="p-6 shadow-[var(--shadow-card)]">
          <h2 className="text-lg font-semibold text-foreground mb-4">
            Recent Activity
          </h2>
          <div className="space-y-2 max-h-80 overflow-y-auto">
            {usageData.length === 0 && !loading && (
              <p className="text-sm text-muted-foreground">No activity yet.</p>
            )}
            {[...usageData]
              .reverse()
              .slice(0, 50)
              .map((row) => (
                <div
                  key={row.id}
                  className="flex items-center justify-between py-2 px-3 rounded-lg hover:bg-muted/50 transition-colors"
                >
                  <div className="flex items-center gap-3">
                    <Badge variant="secondary" className="text-xs">
                      {row.user_name}
                    </Badge>
                    <span className="text-sm text-muted-foreground">
                      analyzed {row.node_count} nodes
                    </span>
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {new Date(row.created_at).toLocaleString()}
                  </span>
                </div>
              ))}
          </div>
        </Card>
      </main>
    </div>
  );
};

export default Usage;
