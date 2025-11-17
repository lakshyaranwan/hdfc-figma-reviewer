import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { AnalysisForm } from "@/components/AnalysisForm";
import { FeedbackDisplay } from "@/components/FeedbackDisplay";
import { Settings } from "lucide-react";
import hdfcLogo from "@/assets/hdfc-logo.png";

export type FeedbackItem = {
  id: string;
  category: "ux" | "ui" | "consistency" | "improvement" | "accessibility" | "design_system" | "high_level";
  title: string;
  description: string;
  severity: "low" | "medium" | "high";
  location?: string;
};

const Index = () => {
  const [feedback, setFeedback] = useState<FeedbackItem[]>([]);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [fileKey, setFileKey] = useState<string>("");
  const navigate = useNavigate();

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b border-border bg-card/50 backdrop-blur-sm sticky top-0 z-10">
        <div className="container mx-auto px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <img src={hdfcLogo} alt="HDFC Logo" className="w-8 h-8 object-contain" />
              <h1 className="text-2xl font-bold text-foreground">HDFC Figma Reviewer</h1>
            </div>
            <Button variant="ghost" size="sm" onClick={() => navigate("/settings")}>
              <Settings className="h-4 w-4 mr-2" />
              Settings
            </Button>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="container mx-auto px-6 py-8 max-w-7xl">
        <div className="grid gap-6 lg:grid-cols-2">
          {/* Analysis Form */}
          <div className="lg:sticky lg:top-24 h-fit">
            <Card className="p-6 shadow-[var(--shadow-card)] hover:shadow-[var(--shadow-hover)] transition-shadow duration-200">
              <AnalysisForm 
                onAnalysisComplete={setFeedback} 
                isAnalyzing={isAnalyzing} 
                setIsAnalyzing={setIsAnalyzing} 
                onFileKeyExtracted={setFileKey} 
              />
            </Card>
          </div>

          {/* Feedback Display */}
          <div>
            <FeedbackDisplay feedback={feedback} isAnalyzing={isAnalyzing} fileKey={fileKey} />
          </div>
        </div>
      </main>
    </div>
  );
};

export default Index;
