'use client';

import React, { useCallback, useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import TextField from '@mui/material/TextField';
import IconButton from '@mui/material/IconButton';
import Checkbox from '@mui/material/Checkbox';
import Tooltip from '@mui/material/Tooltip';
import DeleteIcon from '@mui/icons-material/Delete';
import AddIcon from '@mui/icons-material/Add';
import { invoke } from "@tauri-apps/api/core";

import { create, writeTextFile, readTextFile, BaseDirectory } from '@tauri-apps/plugin-fs';


interface HighligtConfig {
  id: number;
  text: string;
  color: string;
  is_regex: boolean;
  whole_line: boolean;
}


export function useCustomHilightsState(p0?: never[]): [HighligtConfig[] | undefined, (newValue: HighligtConfig[]) => void] {
    const [value, setValue] = useState<HighligtConfig[]>();

    useEffect(() => {
        return () => {
        // do cleanup
        };
    }, [value]);

    const customSetValue = useCallback((newValue:HighligtConfig[]) => {
        setValue(newValue);
        invoke<string[]>("set_highlights", { highlights: newValue })
            .then((s) => {
                //console.log("Update highlights:",s);
                saveHighlightsToFile(newValue);
            }).catch((err: unknown) => {
                console.error(err);
            });
    }, []);
    // Sauvegarde des surlignages dans un fichier JSON local
    async function saveHighlightsToFile(highlightsToSave: HighligtConfig[]) {
        const filePath = 'highlight_settings.json';
        try {
            await writeTextFile(
            filePath,
            JSON.stringify(highlightsToSave, null, 2), { baseDir: BaseDirectory.AppConfig }
            );
        } catch (e) {
            console.log('Erreur lors de la sauvegarde : ' + e);
        }
    }
    return [value, customSetValue];
}

const HighLighSettings: React.FC = () => {
    const [highlights, setHighlights] = useCustomHilightsState([]);






    // Chargement des surlignages depuis le fichier JSON au démarrage
    async function loadHighlightsFromFile() {
        const filePath = 'highlight_settings.json';
        try {
            const result = await readTextFile(filePath, { baseDir: BaseDirectory.AppConfig });
            const highlights = JSON.parse(result);
            let tmpArr: HighligtConfig[] = [];
            highlights.forEach((h:HighligtConfig) => tmpArr.push({ id: h.id, text: h.text, color: h.color, is_regex: h.is_regex ?? true, whole_line: h.whole_line ?? false }));
            setHighlights(tmpArr);
        } catch (e) {
            console.log('Erreur lors du chargement : ' + e);
        }  
    }
    useEffect(() => {
        loadHighlightsFromFile();
        console.log("run once");
    }, []);
    const handleAddHighlight = async () => {
        if(highlights == undefined) {
            setHighlights([{ id: Date.now(), text: '', color: '#cc7f12', is_regex: true, whole_line: false }]);
            return;
        };
        setHighlights([...highlights, { id: Date.now(), text: '', color: '#cc7f12', is_regex: true, whole_line: false }]);
    };

    const handleRemoveHighlight = (id: number) => {
        if(highlights == undefined) return;
        setHighlights(highlights.filter(f => f.id !== id));
    };

    const handleHighlightChange = (id: number, field: keyof HighligtConfig, value: string) => {
        if(highlights == undefined) return;
        setHighlights(highlights.map(f => f.id === id ? { ...f, [field]: value } : f));
    };

    const handleHighlightIsRegexChange = (id: number, value: boolean) => {
        if(highlights == undefined) return;
        setHighlights(highlights.map(f => f.id === id ? { ...f, is_regex: value } : f));
    };

    const handleHighlightWholeLineChange = (id: number, value: boolean) => {
        if(highlights == undefined) return;
        setHighlights(highlights.map(f => f.id === id ? { ...f, whole_line: value } : f));
    };

    return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1, mt: 2 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <Typography variant="subtitle2">Highlight sentence</Typography>
        <IconButton size="small" onClick={handleAddHighlight}>
            <AddIcon />
        </IconButton>
        </Box>
        {highlights?.map((filter) => (
        <Box key={filter.id} sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <TextField
            size="small"
            placeholder="Filter text"
            value={filter.text}
            onChange={(e) => handleHighlightChange(filter.id, 'text', e.target.value)}
            sx={{ flexGrow: 1 }}
            />
            <input
            type="color"
            value={filter.color.slice(0, 7)}
            onChange={(e) => handleHighlightChange(filter.id, 'color', e.target.value)}
            style={{ width: 40, height: 40, padding: 0, border: 'none', background: 'none', cursor: 'pointer' }}
            />
            <Tooltip title="Regex">
              <Checkbox
                size="small"
                checked={filter.is_regex}
                onChange={(e) => handleHighlightIsRegexChange(filter.id, e.target.checked)}
              />
            </Tooltip>
            <Tooltip title="Whole line">
              <Checkbox
                size="small"
                checked={filter.whole_line}
                onChange={(e) => handleHighlightWholeLineChange(filter.id, e.target.checked)}
              />
            </Tooltip>
            <IconButton size="small" onClick={() => handleRemoveHighlight(filter.id)}>
            <DeleteIcon />
            </IconButton>
        </Box>
        ))}
    </Box>
    );
};

export default HighLighSettings;

